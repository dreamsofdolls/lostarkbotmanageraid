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
const { isSupportClass } = require("../../models/Class");
const { getCharacterName, getCharacterClass } = require("../../utils/raid/common/shared");
const { normalizeCatalogLogs } = require("./catalog");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_CHARACTERS = 24;
// One select menu holds at most 25 options.
const MAX_ENTRIES = 25;

/**
 * @param {{ bibleLimiter?: object, client?: object, now?: () => number, ttlMs?: number, deadlineMs?: number, log?: object }} deps
 * @returns {{ load: Function, countCandidates: Function }}
 */
function createRecentRaidLogs({
  bibleLimiter, client = createBibleClient({ bibleLimiter }), now = Date.now,
  ttlMs = 5 * 60_000, deadlineMs = 45_000, log = console,
}) {
  const cache = new Map();

  function candidatesOf(accounts = []) {
    const characters = accounts.flatMap(account => (account.characters || [])
      .filter(character => String(getCharacterName(character)).trim()));
    characters.sort((a, b) => b.itemLevel - a.itemLevel);
    return { chosen: characters.slice(0, MAX_RECENT_CHARACTERS), capped: characters.length > MAX_RECENT_CHARACTERS };
  }

  async function logsOf(character) {
    const name = String(getCharacterName(character)).trim();
    let { bibleSerial: serial, bibleCid: cid, bibleRid: rid } = character;
    let className = getCharacterClass(character);
    if (!serial || !cid || !rid) {
      ({ sn: serial, cid, rid, className } = await client.fetchBibleCharacterProfileWithLimiter(name));
    }
    const rows = await client.fetchBibleLogsWithLimiter({ serial, cid, rid, className, page: 1 });
    return normalizeCatalogLogs(rows, name).map(entry => ({ ...entry, className, support: isSupportClass(className) }));
  }

  /**
   * @param {string} ownerId
   * @param {object[]} accounts the owner's saved accounts, read fresh
   * @param {{ refresh?: boolean }} [options]
   * @returns {Promise<{ entries: object[], private: string[], characters: number, logs: number, capped: boolean, timedOut: boolean }>}
   */
  async function load(ownerId, accounts, { refresh = false } = {}) {
    const cached = cache.get(ownerId);
    if (!refresh && cached && cached.expires > now()) return cached.value;
    const { chosen, capped } = candidatesOf(accounts);
    const privateNames = [];
    const gathered = [];
    let characters = 0;
    const work = Promise.all(chosen.map(async character => {
      const name = String(getCharacterName(character)).trim();
      const disabledAt = character.publicLogDisabledAt ? new Date(character.publicLogDisabledAt).getTime() : 0;
      if (character.publicLogDisabled && now() - disabledAt < DAY_MS) {
        privateNames.push(name);
        return;
      }
      try {
        gathered.push(...await logsOf(character));
        characters += 1;
      } catch (error) {
        if (isPublicLogDisabledError(error)) privateNames.push(name);
        else log.warn(`[raid-log] recent logs skipped ${name}: ${error.message}`);
      }
    }));
    let timer;
    const timedOut = await Promise.race([
      work.then(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(true), deadlineMs); }),
    ]);
    clearTimeout(timer);
    const entries = [...gathered].sort((a, b) => b.timestamp - a.timestamp);
    const value = {
      entries: entries.slice(0, MAX_ENTRIES), private: [...privateNames].sort((a, b) => a.localeCompare(b)),
      characters, logs: entries.length, capped, timedOut,
    };
    cache.set(ownerId, { value, expires: now() + ttlMs });
    return value;
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
