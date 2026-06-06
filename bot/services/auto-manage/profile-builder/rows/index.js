"use strict";

const {
  booleanFlag,
  durationToMs,
  finiteNumber,
  normalizeDifficultyToModeKey,
  normalizeKey,
} = require("../../bible/log-utils");
const {
  MIN_PROFILE_DURATION_MS,
} = require("../config/constants");
const {
  normalizePercentileValue,
  round2,
} = require("../stats/math");
const {
  classRoleFor,
  roleForLog,
} = require("../stats/role");

function parseBibleBuffs(value) {
  const list = Array.isArray(value) ? value : [];
  return {
    supportAp: round2(finiteNumber(list[0], 0)),
    supportBrand: round2(finiteNumber(list[1], 0)),
    supportIdentity: round2(finiteNumber(list[2], 0)),
    supportHyper: round2(finiteNumber(list[3], 0)),
    hasSupportBuffs: list.some((entry) => Number.isFinite(Number(entry))),
  };
}

function stableEncounterId(log, charName) {
  const rawId = String(log?.id || "").trim();
  if (rawId) return `bible:${rawId}`.slice(0, 120);
  return [
    "bible",
    finiteNumber(log?.timestamp, 0),
    normalizeKey(log?.boss),
    normalizeKey(log?.difficulty),
    normalizeKey(charName || log?.name),
  ].join(":").slice(0, 120);
}

function logToProfileRow({ log, rosterEntry, weekResetStart, getRaidGateForBoss, RAID_REQUIREMENT_MAP }) {
  const ts = finiteNumber(log?.timestamp, 0);
  if (!(ts >= weekResetStart)) return null;

  const mapping = getRaidGateForBoss(log?.boss);
  if (!mapping) return null;

  const modeKey = normalizeDifficultyToModeKey(log?.difficulty);
  if (!modeKey || !RAID_REQUIREMENT_MAP?.[`${mapping.raidKey}_${modeKey}`]) return null;

  const durationMs = durationToMs(log?.duration);
  if (durationMs <= MIN_PROFILE_DURATION_MS) return null;

  const className = String(log?.class || rosterEntry.className || "").trim();
  const spec = String(log?.spec || "").trim();
  const classRole = classRoleFor(className);
  const role = roleForLog(className, spec);
  const dps = Math.max(0, finiteNumber(log?.dps, 0));
  const percentileValue = normalizePercentileValue(log?.percentile);
  const overallPercentileValue = normalizePercentileValue(log?.overallPercentile);
  const rawDeathCount = finiteNumber(log?.deathCount ?? log?.deaths, NaN);
  const deathCount = Number.isFinite(rawDeathCount)
    ? Math.max(0, rawDeathCount)
    : booleanFlag(log?.isDead ?? log?.dead) ? 1 : 0;
  const isDead = booleanFlag(log?.isDead ?? log?.dead) || deathCount > 0;
  const itemLevel = finiteNumber(log?.gearScore, 0) || rosterEntry.itemLevel || 0;
  const buffs = parseBibleBuffs(log?.buffs);

  return {
    encounterId: stableEncounterId(log, rosterEntry.charName),
    accountName: rosterEntry.accountName,
    localPlayer: String(rosterEntry.charName || log?.name || "").trim(),
    bibleCharacterName: String(log?.name || "").trim(),
    className,
    itemLevel,
    classRole,
    role,
    boss: String(log?.boss || "").trim(),
    raidKey: mapping.raidKey,
    gate: mapping.gate,
    modeKey,
    difficulty: String(log?.difficulty || "").trim(),
    fightStart: ts,
    durationMs,
    dps,
    udps: Math.max(0, finiteNumber(log?.udps, 0)),
    rdps: Math.max(0, finiteNumber(log?.rdps, 0)),
    ndps: Math.max(0, finiteNumber(log?.ndps, 0)),
    biblePercentile: percentileValue,
    overallBiblePercentile: overallPercentileValue,
    isDead,
    deathCount,
    isBus: booleanFlag(log?.isBus),
    ...buffs,
    build: {
      spec,
      gearScore: round2(log?.gearScore),
      combatPower: round2(log?.combatPower),
    },
  };
}

function rowToEncounterSummary(row, rangeType = "weekly") {
  return {
    accountName: row.accountName,
    characterName: row.localPlayer,
    characterNameKey: normalizeKey(row.localPlayer),
    encounterId: row.encounterId,
    class: row.className,
    itemLevel: row.itemLevel,
    classRole: row.classRole,
    role: row.role,
    fightStart: row.fightStart,
    durationMs: row.durationMs,
    boss: row.boss,
    raidKey: row.raidKey,
    modeKey: row.modeKey,
    difficulty: row.difficulty,
    rangeType,
    db: { source: "lostark.bible" },
    build: row.build,
    metrics: {
      bibleCharacterName: row.bibleCharacterName,
      dps: row.dps,
      udps: row.udps,
      rdps: row.rdps,
      ndps: row.ndps,
      biblePercentile: row.biblePercentile,
      overallBiblePercentile: row.overallBiblePercentile,
      isDead: row.isDead,
      deathCount: row.deathCount,
      isBus: row.isBus,
      supportAp: row.supportAp,
      supportBrand: row.supportBrand,
      supportIdentity: row.supportIdentity,
      supportHyper: row.supportHyper,
      hasSupportBuffs: row.hasSupportBuffs,
      dataDepth: "bible-summary",
    },
    topSkills: [],
  };
}

function encounterSummaryToRow(summary) {
  if (!summary) return null;
  const metrics = summary.metrics || {};
  const build = summary.build || {};
  return {
    encounterId: String(summary.encounterId || "").trim(),
    accountName: String(summary.accountName || "").trim(),
    localPlayer: String(summary.characterName || "").trim(),
    className: String(summary.class || "").trim(),
    itemLevel: finiteNumber(summary.itemLevel, 0),
    classRole: summary.classRole || classRoleFor(summary.class),
    role: summary.role || roleForLog(summary.class, build.spec),
    boss: String(summary.boss || "").trim(),
    raidKey: String(summary.raidKey || "").trim(),
    modeKey: String(summary.modeKey || "").trim(),
    difficulty: String(summary.difficulty || "").trim(),
    fightStart: finiteNumber(summary.fightStart, 0),
    durationMs: durationToMs(summary.durationMs),
    dps: Math.max(0, finiteNumber(metrics.dps, 0)),
    udps: Math.max(0, finiteNumber(metrics.udps, 0)),
    rdps: Math.max(0, finiteNumber(metrics.rdps, 0)),
    ndps: Math.max(0, finiteNumber(metrics.ndps, 0)),
    biblePercentile: normalizePercentileValue(metrics.biblePercentile),
    overallBiblePercentile: normalizePercentileValue(metrics.overallBiblePercentile),
    isDead: booleanFlag(metrics.isDead) || Number(metrics.deathCount) > 0,
    deathCount: Math.max(0, finiteNumber(metrics.deathCount, metrics.isDead ? 1 : 0)),
    isBus: booleanFlag(metrics.isBus),
    supportAp: round2(metrics.supportAp),
    supportBrand: round2(metrics.supportBrand),
    supportIdentity: round2(metrics.supportIdentity),
    supportHyper: round2(metrics.supportHyper),
    hasSupportBuffs: booleanFlag(metrics.hasSupportBuffs),
    build: {
      spec: String(build.spec || "").trim(),
      gearScore: round2(build.gearScore),
      combatPower: round2(build.combatPower),
    },
  };
}

module.exports = {
  encounterSummaryToRow,
  logToProfileRow,
  rowToEncounterSummary,
};
