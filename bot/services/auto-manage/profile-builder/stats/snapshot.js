"use strict";

const {
  PROFILE_VERSION,
} = require("../../../local-sync/profile/payload-sanitizer");
const {
  finiteNumber,
  normalizeKey,
} = require("../../bible/log-utils");
const {
  BIBLE_PROFILE_SOURCE,
  ENTRY_SEP,
  MIN_PROFILE_DURATION_MS,
} = require("../config/constants");
const {
  average,
  clampScore,
  consistencyScore,
  maxPositive,
  minPositive,
  percentile,
  round1,
  round2,
} = require("./math");
const {
  compactKey,
} = require("./role");

// Minimum logs in the secondary (off-meta) build before a support-class
// character is treated as flex and its alt build is scored on its own. Below
// this the sample is too thin to be worth a second score line.
const MIN_ALT_BUILD_LOGS = 3;

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

    // Flex characters (support class that also played a DPS build, or vice
    // versa) get a second score for the off-meta build so /raid-profile can
    // show both. Primary scoring above is untouched; this is additive.
    let altBuild = null;
    if (classRole === "support") {
      const altRole = role === "support" ? "dps" : "support";
      const altRows = role === "support" ? dpsRows : supportRows;
      if (altRows.length >= MIN_ALT_BUILD_LOGS) {
        altBuild = {
          role: altRole,
          encounters: altRows.length,
          scores: computeBibleScores(summarizeRows(altRows), altRole),
        };
      }
    }

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
      altBuild,
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

module.exports = {
  buildSnapshotFromRows,
  summarizeTimeline,
};
