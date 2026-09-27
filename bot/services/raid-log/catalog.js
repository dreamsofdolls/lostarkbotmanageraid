"use strict";

const { createHash } = require("node:crypto");
const { createBibleClient } = require("../auto-manage/bible/client");
const { getRaidGateForBoss, getRaidLabel } = require("../../domain/raid-catalog");
const { RaidLogError } = require("./errors");
const { BIBLE_ORIGIN, normalizeCharacterName, parsePublicLogUrl, parseRaidLogSource } = require("./source");

const MAX_LOG_PAGES = 10;

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
    };
  });
}

function mergeLogs(previous, incoming) {
  return [...new Map([...previous, ...incoming].map(log => [log.id, log])).values()]
    .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
}

function createRaidLogCatalog({ bibleLimiter, client = createBibleClient({ bibleLimiter }) }) {
  const read = (profile, page) => client.fetchBibleLogsWithLimiter({
    serial: profile.sn, cid: profile.cid, rid: profile.rid, className: profile.className, page,
  });
  return {
    async open(input) {
      const { character } = parseRaidLogSource({ character: input });
      const profile = await client.fetchBibleCharacterProfileWithLimiter(character);
      if (normalizeCharacterName(profile.name) !== normalizeCharacterName(character)) throw new RaidLogError("character_mismatch");
      const rows = await read(profile, 1);
      const logs = mergeLogs([], normalizeCatalogLogs(rows, profile.name));
      if (!logs.length) throw new RaidLogError("no_logs");
      return { profile, logs, page: 1, hasMore: rows.length === 25 };
    },
    // Do this before serving even a cached image. A newly private character
    // must revoke the panel instead of continuing from a stale screenshot.
    async verify(catalog) {
      const rows = await read(catalog.profile, 1);
      const logs = normalizeCatalogLogs(rows, catalog.profile.name);
      if (!logs.length) throw new RaidLogError("no_logs");
    },
    async more(catalog) {
      if (!catalog.hasMore || catalog.page >= MAX_LOG_PAGES) throw new RaidLogError("invalid_selection");
      const page = catalog.page + 1;
      const rows = await read(catalog.profile, page);
      const logs = mergeLogs(catalog.logs, normalizeCatalogLogs(rows, catalog.profile.name));
      return { ...catalog, logs, page,
        hasMore: rows.length === 25 && page < MAX_LOG_PAGES && logs.length > catalog.logs.length };
    },
  };
}

module.exports = { createRaidLogCatalog, normalizeCatalogLogs, mergeLogs, MAX_LOG_PAGES };
