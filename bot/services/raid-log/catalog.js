"use strict";

const { createHash } = require("node:crypto");
const { createBibleClient } = require("../auto-manage/bible/client");
const { getRaidGateForBoss, getRaidLabel } = require("../../domain/raid-catalog");
const { RaidLogError } = require("./errors");
const { BIBLE_ORIGIN, normalizeCharacterName, parsePublicLogUrl, parseRaidLogSource } = require("./source");

const MAX_LOG_PAGES = 10;
// Bible's log list pages hold 25 rows; only a full page can have another after it.
const BIBLE_PAGE_SIZE = 25;
const MAX_LOGS = MAX_LOG_PAGES * BIBLE_PAGE_SIZE;
// The latest time a Date can hold.
const MAX_DATE_MS = 8.64e15;

// Bible omits a figure it has no value for; a number that is missing or not
// finite stays null so the card shows "-" rather than 0.
function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCatalogLogs(rows, character) {
  if (!Array.isArray(rows)) throw new RaidLogError("unavailable");
  const matches = rows.filter(row => normalizeCharacterName(row?.name) === normalizeCharacterName(character));
  if (rows.length && !matches.length) throw new RaidLogError("character_mismatch");
  return matches.map(row => {
    const timestamp = Number(row.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > MAX_DATE_MS
      || typeof row.boss !== "string" || !row.boss || !row.id) {
      throw new RaidLogError("unavailable");
    }
    let link;
    try { link = parsePublicLogUrl(`${BIBLE_ORIGIN}/logs/${row.id}`); }
    catch (error) { throw new RaidLogError("unavailable", error); }
    const raid = getRaidGateForBoss(row.boss);
    return {
      ...link, character, timestamp, difficulty: String(row.difficulty || ""),
      duration: Number(row.duration) || 0, gate: raid?.gate || "",
      raidKey: raid?.raidKey || `boss-${createHash("sha256").update(row.boss).digest("hex").slice(0,16)}`,
      raidLabel: raid ? getRaidLabel(raid.raidKey) : row.boss,
      spec: typeof row.spec === "string" ? row.spec : "",
      dps: finiteOrNull(row.dps), ndps: finiteOrNull(row.ndps),
      percentile: finiteOrNull(row.percentile), normalizedPercentile: finiteOrNull(row.normalizedPercentile),
      contributionPercentile: finiteOrNull(row.contributionPercentile), rContribution: finiteOrNull(row.rContribution),
      buffs: Array.isArray(row.buffs) ? row.buffs.map(finiteOrNull) : null,
      isDead: row.isDead === true, isBus: row.isBus === true,
    };
  });
}

function mergeLogs(previous, incoming) {
  return [...new Map([...previous, ...incoming].map(log => [log.id, log])).values()]
    .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
}

function createRaidLogCatalog({ bibleLimiter, client = createBibleClient({ bibleLimiter }), timeoutMs = 30_000 }) {
  // One page of the profile's logs: Bible's rows and the logs normalized from them.
  async function readLogs(profile, page, signal = AbortSignal.timeout(timeoutMs)) {
    const rows = await client.fetchBibleLogsWithLimiter({
      serial: profile.sn, cid: profile.cid, rid: profile.rid, className: profile.className, page,
    }, { signal });
    return { rows, logs: normalizeCatalogLogs(rows, profile.name) };
  }
  // Page 1 decides whether the character still shares logs at all.
  async function readFirstPage(profile, signal) {
    const page = await readLogs(profile, 1, signal);
    if (!page.logs.length) throw new RaidLogError("no_logs");
    return page;
  }
  const catalog = {
    async open(input, { logId, signal = AbortSignal.timeout(timeoutMs) } = {}) {
      const { character } = parseRaidLogSource({ character: input });
      const profile = await client.fetchBibleCharacterProfileWithLimiter(character, { signal });
      if (normalizeCharacterName(profile.name) !== normalizeCharacterName(character)) throw new RaidLogError("character_mismatch");
      const { rows, logs } = await readFirstPage(profile, signal);
      let result = { profile, logs: mergeLogs([], logs), page: 1, hasMore: rows.length === BIBLE_PAGE_SIZE };
      // A Recent selection may have moved beyond page 1 since that list was read.
      while (logId && !result.logs.some(entry => entry.id === logId) && result.hasMore) {
        result = await catalog.more(result, { signal });
      }
      return result;
    },
    // Do this before serving even a cached image. A newly private character
    // must revoke the panel instead of continuing from a stale screenshot.
    async verify(catalog, { signal } = {}) {
      await readFirstPage(catalog.profile, signal);
    },
    async refresh(catalog, { signal } = {}) {
      const { rows, logs: fresh } = await readFirstPage(catalog.profile, signal);
      const logs = mergeLogs(catalog.logs, fresh).slice(0, MAX_LOGS);
      return { ...catalog, logs, hasMore: logs.length < MAX_LOGS
        && (catalog.page === 1 ? rows.length === BIBLE_PAGE_SIZE : catalog.hasMore) };
    },
    async more(catalog, { signal } = {}) {
      if (!catalog.hasMore || catalog.page >= MAX_LOG_PAGES) throw new RaidLogError("invalid_selection");
      const page = catalog.page + 1;
      const { rows, logs: incoming } = await readLogs(catalog.profile, page, signal);
      const logs = mergeLogs(catalog.logs, incoming).slice(0, MAX_LOGS);
      return { ...catalog, logs, page, hasMore: rows.length === BIBLE_PAGE_SIZE && page < MAX_LOG_PAGES
        && logs.length < MAX_LOGS && logs.length > catalog.logs.length };
    },
  };
  return catalog;
}

module.exports = { createRaidLogCatalog, normalizeCatalogLogs };
