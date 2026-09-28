"use strict";

const { createHash } = require("node:crypto");
const { createBibleClient } = require("../auto-manage/bible/client");
const { getRaidGateForBoss, getRaidLabel } = require("../../domain/raid-catalog");
const { RaidLogError } = require("./errors");
const { BIBLE_ORIGIN, normalizeCharacterName, parsePublicLogUrl, parseRaidLogSource } = require("./source");

const MAX_LOG_PAGES = 10;

// Bible omits a figure it has no value for; a number that is missing or not
// finite stays null so the card shows "-" rather than 0.
function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCatalogLogs(rows, character) {
  if (!Array.isArray(rows)) throw new RaidLogError("unavailable");
  const matches = rows.filter(row => normalizeCharacterName(row?.name) === normalizeCharacterName(character));
  if (rows.length && !matches.length) throw new RaidLogError("character_mismatch");
  return matches.map(row => {
    if (!Number.isFinite(Number(row.timestamp)) || Number(row.timestamp) <= 0
      || Number(row.timestamp) > 8.64e15 || typeof row.boss !== "string" || !row.boss || !row.id) {
      throw new RaidLogError("unavailable");
    }
    let link;
    try { link = parsePublicLogUrl(`${BIBLE_ORIGIN}/logs/${row.id}`); }
    catch (error) { throw new RaidLogError("unavailable", error); }
    const raid = getRaidGateForBoss(row.boss);
    return {
      ...link, character, timestamp: Number(row.timestamp), difficulty: String(row.difficulty || ""),
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
  const read = (profile, page, signal = AbortSignal.timeout(timeoutMs)) => client.fetchBibleLogsWithLimiter({
    serial: profile.sn, cid: profile.cid, rid: profile.rid, className: profile.className, page,
  }, { signal });
  const catalog = {
    async open(input, { logId, signal = AbortSignal.timeout(timeoutMs) } = {}) {
      const { character } = parseRaidLogSource({ character: input });
      const profile = await client.fetchBibleCharacterProfileWithLimiter(character, { signal });
      if (normalizeCharacterName(profile.name) !== normalizeCharacterName(character)) throw new RaidLogError("character_mismatch");
      const rows = await read(profile, 1, signal);
      const logs = mergeLogs([], normalizeCatalogLogs(rows, profile.name));
      if (!logs.length) throw new RaidLogError("no_logs");
      let result = { profile, logs, page: 1, hasMore: rows.length === 25 };
      // A Recent selection may have moved beyond page 1 since that list was read.
      while (logId && !result.logs.some(entry => entry.id === logId) && result.hasMore) {
        result = await catalog.more(result, { signal });
      }
      return result;
    },
    // Do this before serving even a cached image. A newly private character
    // must revoke the panel instead of continuing from a stale screenshot.
    async verify(catalog, { signal } = {}) {
      const rows = await read(catalog.profile, 1, signal);
      const logs = normalizeCatalogLogs(rows, catalog.profile.name);
      if (!logs.length) throw new RaidLogError("no_logs");
    },
    async refresh(catalog, { signal } = {}) {
      const rows = await read(catalog.profile, 1, signal);
      const fresh = normalizeCatalogLogs(rows, catalog.profile.name);
      if (!fresh.length) throw new RaidLogError("no_logs");
      const logs = mergeLogs(catalog.logs, fresh).slice(0, MAX_LOG_PAGES * 25);
      return { ...catalog, logs, hasMore: logs.length < MAX_LOG_PAGES * 25
        && (catalog.page === 1 ? rows.length === 25 : catalog.hasMore) };
    },
    async more(catalog, { signal } = {}) {
      if (!catalog.hasMore || catalog.page >= MAX_LOG_PAGES) throw new RaidLogError("invalid_selection");
      const page = catalog.page + 1;
      const rows = await read(catalog.profile, page, signal);
      const logs = mergeLogs(catalog.logs, normalizeCatalogLogs(rows, catalog.profile.name)).slice(0, MAX_LOG_PAGES * 25);
      return { ...catalog, logs, page,
        hasMore: rows.length === 25 && page < MAX_LOG_PAGES && logs.length < MAX_LOG_PAGES * 25 && logs.length > catalog.logs.length };
    },
  };
  return catalog;
}

module.exports = { createRaidLogCatalog, normalizeCatalogLogs, mergeLogs, MAX_LOG_PAGES };
