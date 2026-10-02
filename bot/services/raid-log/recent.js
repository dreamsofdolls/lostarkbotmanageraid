"use strict";

/**
 * bot/services/raid-log/recent.js
 * "Log gần đây": the newest public logs across one user's saved roster,
 * newest first, like Bible's dashboard. One Bible request per character
 * through the stored Bible ids (a profile lookup first when they are
 * missing). Characters Auto-sync saw with Public Log off in the last day are
 * skipped, as the daily sync does. Results are kept per user for a while.
 */

const { createBibleClient } = require("../auto-manage/bible/client");
const { isPublicLogDisabledError } = require("../auto-manage/bible/error-kinds");
const { mapWithConcurrency } = require("../auto-manage/runtime/support/helpers");
const { isSupportClass } = require("../../models/Class");
const { getCharacterName, getCharacterClass } = require("../../utils/raid/common/shared");
const { normalizeCatalogLogs } = require("./catalog");
const { RaidLogError, raidLogErrorCode } = require("./errors");
const { createMemoryCache } = require("./memory-cache");
const { normalizeCharacterName } = require("./source");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_CHARACTERS = 24;
// One select menu holds at most 25 options.
const MAX_ENTRIES = 25;
// Two characters at a time, as Auto-sync reads Bible, so other Bible callers
// keep their place in the shared limiter's queue.
const CONCURRENCY = 2;

/**
 * @param {{ bibleLimiter?: object, client?: object, now?: () => number, ttlMs?: number, deadlineMs?: number, log?: object }} deps
 * @returns {{ load: Function, countCandidates: Function }}
 */
function createRecentRaidLogs({
  bibleLimiter, client = createBibleClient({ bibleLimiter }), now = Date.now,
  ttlMs = 5 * 60_000, deadlineMs = 45_000, log = console,
}) {
  const cache = createMemoryCache({ maxBytes: 2 * 1024 * 1024, maxEntries: 64, ttlMs, now,
    sizeOf: entry => Buffer.byteLength(entry.key) + Buffer.byteLength(JSON.stringify(entry.value)) });
  const pending = new Map();

  function candidatesOf(accounts = []) {
    const characters = accounts.flatMap(account => (account.characters || [])
      .filter(character => String(getCharacterName(character)).trim()));
    characters.sort((a, b) => b.itemLevel - a.itemLevel);
    // Legacy/corrupt rosters can hold the same character under two accounts.
    // Keep the highest-iLvl copy before applying the cap so it consumes one
    // Bible request and cannot displace another real character.
    const unique = new Map();
    for (const character of characters) {
      const key = normalizeCharacterName(getCharacterName(character));
      if (!unique.has(key)) unique.set(key, character);
    }
    const candidates = [...unique.values()];
    return { chosen: candidates.slice(0, MAX_RECENT_CHARACTERS), capped: candidates.length > MAX_RECENT_CHARACTERS };
  }

  function snapshot(character) {
    const disabledAt = new Date(character.publicLogDisabledAt || 0).getTime();
    return {
      name: String(getCharacterName(character)).trim(), className: getCharacterClass(character),
      serial: character.bibleSerial, cid: character.bibleCid, rid: character.bibleRid,
      private: Boolean(character.publicLogDisabled && now() - disabledAt < DAY_MS),
    };
  }

  async function logsOf(character, signal) {
    const { name } = character;
    let { serial, cid, rid, className } = character;
    signal.throwIfAborted();
    if (!serial || !cid || !rid) {
      ({ sn: serial, cid, rid, className } = await client.fetchBibleCharacterProfileWithLimiter(name, { signal }));
    }
    signal.throwIfAborted();
    const rows = await client.fetchBibleLogsWithLimiter({ serial, cid, rid, className, page: 1 }, { signal });
    return normalizeCatalogLogs(rows, name).map(entry => ({ ...entry, className, support: isSupportClass(className) }));
  }

  /**
   * @param {string} ownerId
   * @param {object[]} accounts the owner's saved accounts, read fresh
   * @param {{ refresh?: boolean }} [options]
   * @returns {Promise<{ entries: object[], private: string[], characters: number, logs: number, capped: boolean, timedOut: boolean }>}
   *   rejects when no logs were found and some reads failed; incomplete results are not cached
   */
  async function load(ownerId, accounts, { refresh = false } = {}) {
    const { chosen, capped } = candidatesOf(accounts);
    const candidates = chosen.map(snapshot);
    const key = JSON.stringify({ candidates, capped });
    const current = pending.get(ownerId);
    if (current?.key === key && (!refresh || current.refresh)) return current.promise;
    const cached = cache.get(ownerId);
    if (!refresh && cached?.key === key) return cached.value;
    cache.delete(ownerId);
    const request = { key, refresh };
    pending.set(ownerId, request);
    request.promise = gather(candidates, capped).then(({ value, complete }) => {
      // Only the newest request for this roster may publish its result.
      if (complete && pending.get(ownerId) === request) cache.set(ownerId, { key, value });
      return value;
    }).finally(() => {
      if (pending.get(ownerId) === request) pending.delete(ownerId);
    });
    return request.promise;
  }

  async function gather(candidates, capped) {
    const privateNames = [];
    const gathered = [];
    const failures = [];
    let characters = 0;
    const controller = new AbortController();
    const { signal } = controller;
    const work = mapWithConcurrency(candidates, CONCURRENCY, async character => {
      if (signal.aborted) return;
      const { name } = character;
      if (character.private) {
        privateNames.push(name);
        return;
      }
      try {
        const logs = await logsOf(character, signal);
        if (signal.aborted) return;
        gathered.push(...logs);
        characters += 1;
      } catch (error) {
        if (signal.aborted) return;
        if (isPublicLogDisabledError(error)) {
          privateNames.push(name);
        } else {
          failures.push(error);
          log.warn(`[raid-log] recent logs skipped ${name}: ${error.message}`);
        }
      }
    });
    let timer;
    let timedOut;
    try {
      timedOut = await Promise.race([
        work.then(() => false),
        new Promise(resolve => { timer = setTimeout(() => {
          controller.abort(new DOMException("Recent logs deadline exceeded", "TimeoutError"));
          resolve(true);
        }, deadlineMs); }),
      ]);
    } finally { clearTimeout(timer); }
    // An empty successful read cannot establish that the failed characters have no logs.
    if (!gathered.length && failures.length) {
      throw failures.find(error => raidLogErrorCode(error) === "rate_limited") || failures[0];
    }
    if (!gathered.length && timedOut) throw new RaidLogError("timeout");
    const entries = [...gathered].sort((a, b) => b.timestamp - a.timestamp);
    const value = {
      entries: entries.slice(0, MAX_ENTRIES), private: [...privateNames].sort((a, b) => a.localeCompare(b)),
      characters, logs: entries.length, capped, timedOut,
    };
    return { value, complete: !timedOut && failures.length === 0 };
  }

  /**
   * @param {object[]} accounts
   * @returns {number} characters a load considers: the highest item levels, up to MAX_RECENT_CHARACTERS
   */
  function countCandidates(accounts) {
    return candidatesOf(accounts).chosen.length;
  }

  return { load, countCandidates };
}

module.exports = { createRecentRaidLogs, MAX_RECENT_CHARACTERS };
