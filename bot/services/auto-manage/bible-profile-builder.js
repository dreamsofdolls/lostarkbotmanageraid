"use strict";

const {
  booleanFlag,
  durationToMs,
  finiteNumber,
  normalizeDifficultyToModeKey,
} = require("./bible-log-utils");
const {
  BIBLE_PROFILE_SOURCE,
  MIN_PROFILE_DURATION_MS,
} = require("./profile-builder/constants");
const {
  roleForLog,
} = require("./profile-builder/role");
const {
  buildRosterIndex,
  filterSummariesForCurrentRoster,
} = require("./profile-builder/roster");
const {
  encounterSummaryToRow,
  logToProfileRow,
  rowToEncounterSummary,
} = require("./profile-builder/rows");
const {
  buildSnapshotFromRows,
  summarizeTimeline,
} = require("./profile-builder/snapshot");

function buildBibleProfileSnapshot({ discordId, userDoc, weekResetStart, collected, deps, nowMs = Date.now() }) {
  const {
    getCharacterName,
    getCharacterClass,
    getRaidGateForBoss,
    RAID_REQUIREMENT_MAP,
  } = deps;

  const rosterIndex = buildRosterIndex(userDoc, { getCharacterName, getCharacterClass });
  const rows = [];
  const summaries = [];

  for (const gathered of collected || []) {
    if (!gathered || gathered.error || !Array.isArray(gathered.logs)) continue;
    const rosterEntry = rosterIndex.get(gathered.entryKey) || {
      accountName: String(gathered.accountName || "").trim(),
      charName: String(gathered.canonicalName || gathered.charName || "").trim(),
      className: String(gathered.className || "").trim(),
      itemLevel: 0,
    };
    if (!rosterEntry.accountName || !rosterEntry.charName) continue;

    for (const log of gathered.logs) {
      const row = logToProfileRow({
        log,
        rosterEntry,
        weekResetStart,
        getRaidGateForBoss,
        RAID_REQUIREMENT_MAP,
      });
      if (!row) continue;
      rows.push(row);
      summaries.push(rowToEncounterSummary(row, "weekly"));
    }
  }

  const built = buildSnapshotFromRows({
    rows,
    summaries,
    rangeType: "weekly",
    rangeStart: weekResetStart,
    nowMs,
  });
  if (!built) return null;
  return { discordId, ...built };
}

function buildBibleProfileSnapshotFromEncounterSummaries({
  summaries,
  nowMs = Date.now(),
  rangeType = "full",
  rangeStart = null,
}) {
  const sourceSummaries = (summaries || []).filter(
    (summary) => summary?.db?.source === "lostark.bible" || summary?.metrics?.dataDepth === "bible-summary"
  );
  const validPairs = sourceSummaries
    .map((summary) => ({ summary, row: encounterSummaryToRow(summary) }))
    .filter(({ row }) => row?.accountName && row.localPlayer && row.fightStart > 0 && row.durationMs > MIN_PROFILE_DURATION_MS);
  const rows = validPairs.map(({ row }) => row);
  const validSummaries = validPairs.map(({ summary }) => summary);
  const { firstFightStart } = summarizeTimeline(rows);
  return buildSnapshotFromRows({
    rows,
    summaries: validSummaries,
    rangeType,
    rangeStart: Number(rangeStart) || firstFightStart || 0,
    nowMs,
  });
}

function buildBibleWeeklySnapshotFromEncounterSummaries({ summaries, weekResetStart, nowMs = Date.now() }) {
  const start = finiteNumber(weekResetStart, 0);
  if (!start) return null;
  const weeklySummaries = (summaries || []).filter((summary) => finiteNumber(summary?.fightStart, 0) >= start);
  if (!weeklySummaries.length) return null;
  return buildBibleProfileSnapshotFromEncounterSummaries({
    summaries: weeklySummaries,
    nowMs,
    rangeType: "weekly",
    rangeStart: start,
  });
}

module.exports = {
  BIBLE_PROFILE_SOURCE,
  MIN_PROFILE_DURATION_MS,
  buildBibleProfileSnapshot,
  buildBibleProfileSnapshotFromEncounterSummaries,
  buildBibleWeeklySnapshotFromEncounterSummaries,
  filterSummariesForCurrentRoster,
  booleanFlag,
  durationToMs,
  normalizeDifficultyToModeKey,
  roleForLog,
};
