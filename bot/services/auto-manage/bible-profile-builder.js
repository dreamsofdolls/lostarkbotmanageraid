"use strict";

const {
  PROFILE_VERSION,
} = require("../local-sync/profile-payload-sanitizer");

const MIN_PROFILE_DURATION_MS = 3 * 60 * 1000;
const BIBLE_PROFILE_SOURCE = "bible";
const ENTRY_SEP = "\x1f";

const SUPPORT_CLASS_KEYS = new Set([
  "artist",
  "bard",
  "paladin",
  "holyknight",
  "holy knight",
  "valkyrie",
]);
const SUPPORT_MAIN_SPEC_KEYS = new Set([
  "blessedaura",
  "desperatesalvation",
  "fullbloom",
  "liberator",
]);
const SUPPORT_DPS_SPEC_KEYS = new Set([
  "judgment",
  "truecourage",
  "recurrence",
  "shiningknight",
]);

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function compactKey(value) {
  return normalizeKey(value).replace(/[^a-z0-9]/g, "");
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round1(value) {
  return Math.round((finiteNumber(value) || 0) * 10) / 10;
}

function round2(value) {
  return Math.round((finiteNumber(value) || 0) * 100) / 100;
}

function clampScore(value) {
  const n = finiteNumber(value, 0);
  return Math.max(0, Math.min(100, n));
}

function normalizePercentileValue(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text.endsWith("%") ? text.slice(0, -1) : text);
    if (!Number.isFinite(parsed)) return null;
    return normalizePercentileValue(parsed);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) return clampScore(n * 100);
  return clampScore(n);
}

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

function booleanFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const key = normalizeKey(value);
  if (!key || key === "false" || key === "0" || key === "no" || key === "n") return false;
  if (key === "true" || key === "1" || key === "yes" || key === "y") return true;
  return Boolean(value);
}

function average(values) {
  const nums = (values || []).map((v) => Number(v)).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function percentile(values, p) {
  const nums = (values || []).map((v) => Number(v)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const idx = (nums.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return nums[lo];
  const weight = idx - lo;
  return nums[lo] * (1 - weight) + nums[hi] * weight;
}

function minPositive(values) {
  const nums = (values || []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.min(...nums) : null;
}

function maxPositive(values) {
  const nums = (values || []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : null;
}

function consistencyScore(values) {
  const nums = (values || []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length <= 1) return nums.length ? 65 : 0;
  const mean = average(nums);
  if (mean <= 0) return 0;
  const variance = nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
  const cv = Math.sqrt(variance) / mean;
  return clampScore(100 - cv * 140);
}

function durationToMs(value) {
  if (typeof value === "string") {
    const text = value.trim();
    const mmss = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
    if (mmss) {
      if (mmss[3] !== undefined) {
        return ((Number(mmss[1]) * 60 * 60) + (Number(mmss[2]) * 60) + Number(mmss[3])) * 1000;
      }
      return ((Number(mmss[1]) * 60) + Number(mmss[2])) * 1000;
    }
  }

  const n = finiteNumber(value, 0);
  if (n <= 0) return 0;
  return n < 10000 ? Math.round(n * 1000) : Math.round(n);
}

function normalizeDifficultyToModeKey(difficulty) {
  const key = normalizeKey(difficulty);
  if (key === "nightmare" || key === "9m") return "nightmare";
  if (key === "hard" || key === "hm") return "hard";
  if (key === "normal" || key === "nor" || key === "nm") return "normal";
  return null;
}

function classRoleFor(className) {
  const key = normalizeKey(className);
  if (SUPPORT_CLASS_KEYS.has(key) || SUPPORT_CLASS_KEYS.has(compactKey(className))) return "support";
  return key ? "dps" : "unknown";
}

function roleForLog(className, spec) {
  const classRole = classRoleFor(className);
  if (classRole !== "support") return classRole;
  const specKey = compactKey(spec);
  if (SUPPORT_DPS_SPEC_KEYS.has(specKey)) return "dps";
  if (SUPPORT_MAIN_SPEC_KEYS.has(specKey)) return "support";
  return "support";
}

function buildRosterIndex(userDoc, { getCharacterName, getCharacterClass }) {
  const byEntryKey = new Map();
  for (const account of userDoc?.accounts || []) {
    const accountName = String(account?.accountName || "").trim();
    for (const character of account?.characters || []) {
      const charName = getCharacterName(character);
      if (!accountName || !charName) continue;
      const entryKey = `${normalizeKey(accountName)}${ENTRY_SEP}${normalizeKey(charName)}`;
      byEntryKey.set(entryKey, {
        accountName,
        charName,
        className: getCharacterClass(character),
        itemLevel: finiteNumber(character?.itemLevel, 0),
        character,
      });
    }
  }
  return byEntryKey;
}

function buildRosterSummaryIndexes(userDoc, { getCharacterName, getCharacterClass }) {
  const byEntryKey = new Map();
  const byCharKey = new Map();
  for (const account of userDoc?.accounts || []) {
    const accountName = String(account?.accountName || "").trim();
    for (const character of account?.characters || []) {
      const charName = getCharacterName(character);
      if (!accountName || !charName) continue;
      const entry = {
        accountName,
        charName,
        className: getCharacterClass(character),
        itemLevel: finiteNumber(character?.itemLevel, 0),
      };
      byEntryKey.set(`${normalizeKey(accountName)}${ENTRY_SEP}${normalizeKey(charName)}`, entry);
      if (!byCharKey.has(normalizeKey(charName))) byCharKey.set(normalizeKey(charName), entry);
    }
  }
  return { byEntryKey, byCharKey };
}

function filterSummariesForCurrentRoster(summaries, userDoc, deps) {
  const indexes = buildRosterSummaryIndexes(userDoc, deps);
  return (summaries || []).map((summary) => {
    const accountName = String(summary?.accountName || "").trim();
    const charName = String(summary?.characterName || "").trim();
    const entry = indexes.byEntryKey.get(`${normalizeKey(accountName)}${ENTRY_SEP}${normalizeKey(charName)}`) ||
      indexes.byCharKey.get(normalizeKey(charName));
    if (!entry) return null;
    return {
      ...summary,
      accountName: entry.accountName,
      characterName: entry.charName,
      characterNameKey: normalizeKey(entry.charName),
      class: summary.class || entry.className || "",
      itemLevel: finiteNumber(summary.itemLevel, 0) || entry.itemLevel || 0,
      classRole: summary.classRole || classRoleFor(summary.class || entry.className),
    };
  }).filter(Boolean);
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

function summarizeRows(rows) {
  const dps = rows.map((row) => row.dps);
  const rdps = rows.map((row) => row.rdps).filter((n) => n > 0);
  const ndps = rows.map((row) => row.ndps).filter((n) => n > 0);
  const udps = rows.map((row) => row.udps).filter((n) => n > 0);
  const buffRows = rows.filter((row) => row.hasSupportBuffs);
  const percentiles = rows
    .map((row) => row.biblePercentile)
    .filter((n) => Number.isFinite(Number(n)));
  const overallPercentiles = rows
    .map((row) => row.overallBiblePercentile)
    .filter((n) => Number.isFinite(Number(n)));
  const deathCounts = rows.map((row) => Math.max(0, finiteNumber(row.deathCount, row.isDead ? 1 : 0)));
  const totalDeaths = deathCounts.reduce((sum, n) => sum + n, 0);
  const deathRows = deathCounts.filter((n) => n > 0).length;
  const busRows = rows.filter((row) => row.isBus).length;
  const contextCoverageRate = rows.length ? (percentiles.length / rows.length) * 100 : 0;
  const overallCoverageRate = rows.length ? (overallPercentiles.length / rows.length) * 100 : 0;
  const avgBiblePercentile = average(percentiles);
  const avgOverallBiblePercentile = average(overallPercentiles);
  return {
    encounters: rows.length,
    allEncounterCount: rows.length,
    firstFightStart: minPositive(rows.map((row) => row.fightStart)),
    lastFightStart: maxPositive(rows.map((row) => row.fightStart)),
    avgDurationMs: Math.round(average(rows.map((row) => row.durationMs))),
    avgActiveDurationMs: Math.round(average(rows.map((row) => row.durationMs))),
    avgActiveTimeRate: 100,
    avgDps: Math.round(average(dps)),
    medianDps: Math.round(percentile(dps, 50)),
    p75Dps: Math.round(percentile(dps, 75)),
    p90Dps: Math.round(percentile(dps, 90)),
    avgRdps: Math.round(average(rdps)),
    medianRdps: Math.round(percentile(rdps, 50)),
    avgNdps: Math.round(average(ndps)),
    medianNdps: Math.round(percentile(ndps, 50)),
    avgUdps: Math.round(average(udps)),
    medianUdps: Math.round(percentile(udps, 50)),
    rdpsValidCount: rdps.length,
    rdpsValidRate: round1(rows.length ? (rdps.length / rows.length) * 100 : 0),
    avgBiblePercentile: round1(avgBiblePercentile),
    medianBiblePercentile: round1(percentile(percentiles, 50)),
    avgOverallBiblePercentile: round1(avgOverallBiblePercentile),
    medianOverallBiblePercentile: round1(percentile(overallPercentiles, 50)),
    biblePercentileCoverageRate: round1(contextCoverageRate),
    overallBiblePercentileCoverageRate: round1(overallCoverageRate),
    contextCoverageRate: round1(contextCoverageRate),
    contextSampleCountAvg: 0,
    avgContextPerformancePercentile: round1(avgOverallBiblePercentile || avgBiblePercentile),
    avgContextSupportPercentile: round1(avgOverallBiblePercentile || avgBiblePercentile),
    deathlessRate: round1(((rows.length - deathRows) / rows.length) * 100),
    deathRate: round1((deathRows / rows.length) * 100),
    totalDeaths: Math.round(totalDeaths),
    avgDeaths: round2(average(deathCounts)),
    totalDeadTimeMs: 0,
    avgDeadTimeMs: 0,
    avgDeadTimeRate: 0,
    busCount: busRows,
    busRate: round1((busRows / rows.length) * 100),
    supportBuffCoverageRate: round1(rows.length ? (buffRows.length / rows.length) * 100 : 0),
    avgSupportAp: round2(average(buffRows.map((row) => row.supportAp))),
    avgSupportBrand: round2(average(buffRows.map((row) => row.supportBrand))),
    avgSupportIdentity: round2(average(buffRows.map((row) => row.supportIdentity))),
    avgSupportHyper: round2(average(buffRows.map((row) => row.supportHyper))),
    avgGearScore: round2(average(rows.map((row) => row.build.gearScore).filter((n) => n > 0))),
    latestGearScore: round2(rows[0]?.build?.gearScore),
    avgCombatPower: round2(average(rows.map((row) => row.build.combatPower).filter((n) => n > 0))),
    latestCombatPower: round2(rows[0]?.build?.combatPower),
    consistency: round1(consistencyScore(dps)),
    profileDataDepth: "bible-summary",
  };
}

function computeBibleScores(stats, role) {
  const percentileScore = Number(stats.avgOverallBiblePercentile) > 0
    ? Number(stats.avgOverallBiblePercentile)
    : Number(stats.avgBiblePercentile) > 0 ? Number(stats.avgBiblePercentile) : 0;
  const survivalScore = clampScore(100 - (Number(stats.deathRate) || 0) * 1.2 - (Number(stats.avgDeaths) || 0) * 12);
  const consistency = clampScore(stats.consistency);
  const confidence = clampScore(Math.max(
    Number(stats.biblePercentileCoverageRate) || 0,
    Number(stats.overallBiblePercentileCoverageRate) || 0
  )) / 100;
  const supportBuffScore = clampScore((
    (Number(stats.avgSupportAp) || 0) * 0.3 +
    (Number(stats.avgSupportBrand) || 0) * 0.3 +
    (Number(stats.avgSupportIdentity) || 0) * 0.25 +
    (Number(stats.avgSupportHyper) || 0) * 0.15
  ) * 100);
  const hasSupportBuffs = role === "support" && Number(stats.supportBuffCoverageRate) > 0;
  const output = percentileScore > 0 ? percentileScore : consistency * 0.65 + survivalScore * 0.35;
  const supportUptime = hasSupportBuffs ? supportBuffScore : output;
  const overall = clampScore(output * (0.7 + confidence * 0.15) + survivalScore * 0.1 + consistency * 0.05);
  const mvp = clampScore(output * 0.75 + consistency * 0.15 + survivalScore * 0.1);
  return {
    overall: round1(overall),
    mvp: round1(mvp),
    context: round1(percentileScore),
    survival: round1(survivalScore),
    consistency: round1(consistency),
    damageShare: 0,
    raidContribution: role === "support" ? round1(output) : 0,
    supportUptime: role === "support" ? round1(supportUptime) : 0,
    protection: role === "support" ? 0 : undefined,
    mechanics: 0,
    sourceConfidence: round1(confidence * 100),
  };
}

function summarizeRaidGroup(rows) {
  const stats = summarizeRows(rows);
  return {
    encounters: rows.length,
    firstFightStart: stats.firstFightStart,
    lastFightStart: stats.lastFightStart,
    avgDurationMs: stats.avgDurationMs,
    avgDps: stats.avgDps,
    medianDps: stats.medianDps,
    p75Dps: stats.p75Dps,
    p90Dps: stats.p90Dps,
    avgRdps: stats.avgRdps,
    avgNdps: stats.avgNdps,
    avgUdps: stats.avgUdps,
    avgBiblePercentile: stats.avgBiblePercentile,
    avgOverallBiblePercentile: stats.avgOverallBiblePercentile,
    deathlessRate: stats.deathlessRate,
    busRate: stats.busRate,
  };
}

function buildVariantName(row) {
  return String(row?.build?.spec || "Unknown build").trim() || "Unknown build";
}

function hasKnownBuildVariant(row) {
  return !!compactKey(row?.build?.spec);
}

function summarizeBuildVariants(rows, { limit = 6 } = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = hasKnownBuildVariant(row) ? compactKey(buildVariantName(row)) : "";
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()]
    .map((groupRows) => {
      const latest = groupRows.reduce((best, row) =>
        (Number(row.fightStart) || 0) > (Number(best.fightStart) || 0) ? row : best
      , groupRows[0]);
      const stats = summarizeRows(groupRows);
      return {
        name: buildVariantName(latest),
        spec: buildVariantName(latest),
        role: latest.role || latest.classRole || "unknown",
        encounters: groupRows.length,
        firstFightStart: stats.firstFightStart,
        lastFightStart: stats.lastFightStart,
        avgDps: stats.avgDps,
        medianDps: stats.medianDps,
        p90Dps: stats.p90Dps,
        avgRdps: stats.avgRdps,
        medianRdps: stats.medianRdps,
        avgNdps: stats.avgNdps,
        medianNdps: stats.medianNdps,
        avgBiblePercentile: stats.avgBiblePercentile,
        avgOverallBiblePercentile: stats.avgOverallBiblePercentile,
      };
    })
    .sort((a, b) =>
      b.encounters - a.encounters ||
      (b.lastFightStart || 0) - (a.lastFightStart || 0) ||
      a.name.localeCompare(b.name)
    )
    .slice(0, limit);
}

function summarizeTimeline(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    firstFightStart: minPositive(list.map((row) => row.fightStart)),
    lastFightStart: maxPositive(list.map((row) => row.fightStart)),
  };
}

function buildSnapshotFromRows({ rows, summaries = [], rangeType = "weekly", rangeStart = 0, nowMs = Date.now() }) {
  const validRows = Array.isArray(rows) ? rows : [];
  const validSummaries = Array.isArray(summaries) ? summaries : [];
  const byChar = new Map();
  for (const row of validRows) {
    const key = `${normalizeKey(row.accountName)}${ENTRY_SEP}${normalizeKey(row.localPlayer)}`;
    if (!byChar.has(key)) byChar.set(key, []);
    byChar.get(key).push(row);
  }

  const accountsByName = new Map();
  for (const charRowsRaw of byChar.values()) {
    const allCharRows = [...charRowsRaw].sort((a, b) => b.fightStart - a.fightStart);
    const classRole = allCharRows[0]?.classRole || "unknown";
    const supportRows = allCharRows.filter((row) => row.role === "support");
    const dpsRows = allCharRows.filter((row) => row.role === "dps");
    const role = classRole === "support"
      ? (supportRows.length >= dpsRows.length ? "support" : "dps")
      : classRole;
    const profileRows = classRole === "support"
      ? (role === "support" ? supportRows : dpsRows)
      : allCharRows;
    const rowsForStats = profileRows.length ? profileRows : allCharRows;
    const sample = rowsForStats[0];
    const stats = summarizeRows(rowsForStats);
    const buildVariants = summarizeBuildVariants(rowsForStats);
    stats.buildVariantCount = buildVariants.length;
    stats.unclassifiedBuildLogCount = rowsForStats.filter((row) => !hasKnownBuildVariant(row)).length;
    if (classRole === "support") {
      stats.supportLogCount = supportRows.length;
      stats.dpsBuildLogCount = dpsRows.length;
      stats.supportLogRate = allCharRows.length ? round1((supportRows.length / allCharRows.length) * 100) : 0;
      stats.dpsBuildLogRate = allCharRows.length ? round1((dpsRows.length / allCharRows.length) * 100) : 0;
      stats.primaryRoleRate = allCharRows.length ? round1((rowsForStats.length / allCharRows.length) * 100) : 0;
    }

    const latest = rowsForStats[0];
    const build = {
      spec: latest?.build?.spec || "",
      gearScore: latest?.build?.gearScore || 0,
      combatPower: latest?.build?.combatPower || 0,
      arkPassiveActive: null,
      engravings: [],
      arkPassive: null,
    };

    const raidGroups = new Map();
    for (const row of rowsForStats) {
      const key = `${row.raidKey}${ENTRY_SEP}${row.modeKey}${ENTRY_SEP}${row.boss}`;
      if (!raidGroups.has(key)) raidGroups.set(key, []);
      raidGroups.get(key).push(row);
    }
    const raids = [...raidGroups.values()].map((groupRows) => ({
      raidKey: groupRows[0].raidKey,
      modeKey: groupRows[0].modeKey,
      boss: groupRows[0].boss,
      ...summarizeRaidGroup(groupRows),
    })).sort((a, b) => (b.lastFightStart || 0) - (a.lastFightStart || 0));

    const accountName = sample.accountName;
    if (!accountsByName.has(accountName)) {
      accountsByName.set(accountName, { accountName, characters: [] });
    }
    accountsByName.get(accountName).characters.push({
      name: sample.localPlayer,
      class: sample.className,
      itemLevel: sample.itemLevel,
      classRole,
      role,
      stats,
      scores: computeBibleScores(stats, role),
      build,
      topSkills: [],
      topBuffSources: [],
      topDebuffSources: [],
      topShieldGivenSources: [],
      topShieldReceivedSources: [],
      buildVariants,
      raids,
    });
  }

  const accounts = [...accountsByName.values()]
    .map((account) => ({
      accountName: account.accountName,
      characters: account.characters.sort((a, b) =>
        (b.stats.lastFightStart || 0) - (a.stats.lastFightStart || 0) ||
        a.name.localeCompare(b.name)
      ),
    }))
    .filter((account) => account.characters.length > 0)
    .sort((a, b) => a.accountName.localeCompare(b.accountName));

  let characterCount = 0;
  let encounterCount = 0;
  let firstFightStart = null;
  let lastFightStart = null;
  for (const account of accounts) {
    characterCount += account.characters.length;
    for (const character of account.characters) {
      encounterCount += Number(character.stats?.encounters) || 0;
      const first = Number(character.stats?.firstFightStart) || 0;
      const last = Number(character.stats?.lastFightStart) || 0;
      if (first && (!firstFightStart || first < firstFightStart)) firstFightStart = first;
      if (last && (!lastFightStart || last > lastFightStart)) lastFightStart = last;
    }
  }

  if (!encounterCount) return null;
  const timeline = summarizeTimeline(validRows);
  const effectiveRangeStart = Number(rangeStart) || timeline.firstFightStart || firstFightStart || 0;

  const snapshot = {
    version: PROFILE_VERSION,
    source: BIBLE_PROFILE_SOURCE,
    rangeType,
    generatedAt: nowMs,
    receivedAt: nowMs,
    criteria: {
      clearedOnly: true,
      supportedBossesOnly: true,
      minDurationMs: MIN_PROFILE_DURATION_MS,
      modernProfileStatsOnly: true,
      source: "lostark.bible",
      dataDepth: "bible-summary",
      range: {
        type: rangeType,
        minFightStartMs: effectiveRangeStart,
        maxFightStartMs: nowMs,
      },
    },
    db: {
      fileName: "lostark.bible",
      size: 0,
      lastModified: nowMs,
    },
    totals: {
      accountCount: accounts.length,
      characterCount,
      encounterCount,
      encounterSummaryCount: validSummaries.length || encounterCount,
      firstFightStart,
      lastFightStart,
      rejectedCharacters: [],
    },
    accounts,
  };

  return { snapshot, encounterSummaries: validSummaries };
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
