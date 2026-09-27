"use strict";

const { createBibleClient } = require("../auto-manage/bible/client");
const { RaidLogError } = require("./errors");
const { BIBLE_ORIGIN, normalizeCharacterName, parsePublicLogUrl, parseRaidLogSource } = require("./source");

function selectLatestCharacterLog(logs, character) {
  if (!Array.isArray(logs)) throw new RaidLogError("unavailable");
  if (!logs.length) throw new RaidLogError("no_logs");
  // Never fall back to another roster member or fold accents away. The Bible
  // API has returned other characters' rows before, even for a valid lookup.
  const expectedName = normalizeCharacterName(character);
  const matches = logs.filter(log => normalizeCharacterName(log?.name) === expectedName);
  if (!matches.length) throw new RaidLogError("character_mismatch");
  if (matches.some(log => !Number.isFinite(Number(log.timestamp)) || Number(log.timestamp) <= 0)) {
    throw new RaidLogError("unavailable");
  }
  const latest = matches.reduce((best, log) => Number(log.timestamp) > Number(best.timestamp) ? log : best);
  if (typeof latest.id !== "string" || !latest.id) throw new RaidLogError("unavailable");
  let parsed;
  try { parsed = parsePublicLogUrl(`${BIBLE_ORIGIN}/logs/${latest.id}`); }
  catch (error) { throw new RaidLogError("unavailable", error); }
  return { ...parsed, character, region: "NA", timestamp: Number(latest.timestamp) };
}

function createLatestRaidLogLookup({
  bibleLimiter,
  client = createBibleClient({ bibleLimiter }),
}) {
  return async function findLatestRaidLog(input) {
    const { character } = parseRaidLogSource({ character: input });
    const profile = await client.fetchBibleCharacterProfileWithLimiter(character);
    if (normalizeCharacterName(profile.name) !== normalizeCharacterName(character)) {
      throw new RaidLogError("character_mismatch");
    }
    // Page 1 is the newest 25 entries, without a weekly reset or raid filter.
    const logs = await client.fetchBibleLogsWithLimiter({
      serial: profile.sn, cid: profile.cid, rid: profile.rid, className: profile.className, page: 1,
    });
    return selectLatestCharacterLog(logs, profile.name);
  };
}

module.exports = { createLatestRaidLogLookup, selectLatestCharacterLog };
