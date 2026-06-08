"use strict";

const {
  average,
  consistencyScore,
  maxPositive,
  minPositive,
  percentile,
  round1,
  round2,
} = require("../../../auto-manage/profile-builder/stats/math");
const {
  normalizeKey,
} = require("./common");

function median(values) {
  return percentile(values, 50);
}

function positiveAverage(values) {
  return average((values || []).filter((n) => Number(n) > 0));
}

function metric(summary, key) {
  return Number(summary?.metrics?.[key]) || 0;
}

function latestSummary(rows) {
  return rows.reduce((best, row) =>
    (Number(row.fightStart) || 0) > (Number(best.fightStart) || 0) ? row : best
  , rows[0]);
}

function deriveStatsFromSummaries(rows, role) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return {};
  const deathCounts = list.map((row) => metric(row, "deathCount"));
  const deathRows = deathCounts.filter((n) => n > 0).length;
  const rdpsRows = list.filter((row) => row?.metrics?.rdpsValid === true);
  const supporterRows = rdpsRows.length ? rdpsRows : list;
  const supporterRankRows = supporterRows.filter((row) =>
    metric(row, "supporterRank") > 0 && metric(row, "supporterCount") > 0
  );
  const supporterCompetitiveRows = supporterRankRows.filter((row) => metric(row, "supporterCount") > 1);
  const contextRows = list.filter((row) =>
    metric(row, "contextSampleCount") > 0 && row?.metrics?.contextSource !== "none"
  );
  const buildSpecs = new Set(list.map((row) => normalizeKey(row?.build?.spec)).filter(Boolean));
  const arkRows = list.filter((row) => row?.build?.arkPassiveActive !== null && row?.build?.arkPassiveActive !== undefined);

  const stats = {
    encounters: list.length,
    firstFightStart: minPositive(list.map((row) => row.fightStart)),
    lastFightStart: maxPositive(list.map((row) => row.fightStart)),
    avgDurationMs: Math.round(average(list.map((row) => row.durationMs))),
    avgActiveDurationMs: Math.round(average(list.map((row) => metric(row, "activeDurationMs")))),
    avgIntermissionMs: Math.round(average(list.map((row) => metric(row, "intermissionMs")))),
    avgActiveTimeRate: round1(average(list.map((row) => metric(row, "activeTimeRate")))),
    avgDps: Math.round(average(list.map((row) => metric(row, "dps")))),
    medianDps: Math.round(median(list.map((row) => metric(row, "dps")))),
    p75Dps: Math.round(percentile(list.map((row) => metric(row, "dps")), 75)),
    p90Dps: Math.round(percentile(list.map((row) => metric(row, "dps")), 90)),
    avgPeak10sDps: Math.round(positiveAverage(list.map((row) => metric(row, "peak10sDps")))),
    p90Peak10sDps: Math.round(percentile(list.map((row) => metric(row, "peak10sDps")).filter((n) => n > 0), 90)),
    avgBurstRatio: round2(positiveAverage(list.map((row) => metric(row, "burstRatio")))),
    avgRdps: Math.round(average(list.map((row) => metric(row, "rdps")))),
    medianRdps: Math.round(median(list.map((row) => metric(row, "rdps")))),
    avgNdps: Math.round(average(list.map((row) => metric(row, "ndps")))),
    medianNdps: Math.round(median(list.map((row) => metric(row, "ndps")))),
    avgDamageShare: round1(average(list.map((row) => metric(row, "damageShare")))),
    medianDamageShare: round1(median(list.map((row) => metric(row, "damageShare")))),
    avgTopDamageProximity: round1(average(list.map((row) => metric(row, "topDamageProximity")))),
    contextCoverageRate: round1((contextRows.length / list.length) * 100),
    contextSampleCountAvg: round1(average(contextRows.map((row) => metric(row, "contextSampleCount")))),
    avgContextPerformancePercentile: round1(average(contextRows.map((row) => metric(row, "contextPerformancePercentile")))),
    avgContextDamageSharePercentile: round1(average(contextRows.map((row) => metric(row, "contextDamageSharePercentile")))),
    avgContextTopDamageProximityPercentile: round1(average(contextRows.map((row) => metric(row, "contextTopDamageProximityPercentile")))),
    avgContextSupportPercentile: round1(average(contextRows.map((row) => metric(row, "contextSupportPercentile")))),
    avgRank: round2(average(list.map((row) => metric(row, "damageRank")).filter((n) => n > 0))),
    partyCountAvg: round2(average(list.map((row) => metric(row, "partyCount")).filter((n) => n > 0))),
    deathlessRate: round1(((list.length - deathRows) / list.length) * 100),
    deathRate: round1((deathRows / list.length) * 100),
    totalDeaths: Math.round(deathCounts.reduce((sum, n) => sum + n, 0)),
    avgDeaths: round2(average(deathCounts)),
    totalDeadTimeMs: Math.round(list.reduce((sum, row) => sum + metric(row, "deadTimeMs"), 0)),
    avgDeadTimeMs: Math.round(average(list.map((row) => metric(row, "deadTimeMs")))),
    avgDeadTimeRate: round1(average(list.map((row) => metric(row, "deadTimeRate")))),
    rdpsValidCount: rdpsRows.length,
    rdpsValidRate: round1((rdpsRows.length / list.length) * 100),
    avgSupporterPercent: round1(average(supporterRows.map((row) => metric(row, "supporterPercent")))),
    medianSupporterPercent: round1(median(supporterRows.map((row) => metric(row, "supporterPercent")))),
    radiantSupportCount: supporterRows.filter((row) => row?.metrics?.supporterTier === "radiant").length,
    avgSupporterDamageGivenPerMinute: Math.round(average(supporterRows.map((row) => metric(row, "supporterDamageGivenPerMinute")))),
    avgRdpsDamageGivenShare: round1(average(rdpsRows.map((row) => metric(row, "rdpsDamageGivenShare")))),
    supporterRankValidCount: supporterRankRows.length,
    supporterCompetitiveCount: supporterCompetitiveRows.length,
    avgSupporterRank: round2(average(supporterRankRows.map((row) => metric(row, "supporterRank")))),
    supporterCountAvg: round2(average(supporterRankRows.map((row) => metric(row, "supporterCount")))),
    avgCounters: round2(average(list.map((row) => metric(row, "counters")))),
    avgCastsPerMinute: round2(average(list.map((row) => metric(row, "castsPerMinute")))),
    avgHitsPerMinute: round2(average(list.map((row) => metric(row, "hitsPerMinute")))),
    avgCritRate: round1(average(list.map((row) => metric(row, "critRate")))),
    avgCritDamageShare: round1(average(list.map((row) => metric(row, "critDamageShare")))),
    avgBackAttackRate: round1(average(list.map((row) => metric(row, "backAttackRate")))),
    avgFrontAttackRate: round1(average(list.map((row) => metric(row, "frontAttackRate")))),
    avgBackAttackDamageShare: round1(average(list.map((row) => metric(row, "backAttackDamageShare")))),
    avgFrontAttackDamageShare: round1(average(list.map((row) => metric(row, "frontAttackDamageShare")))),
    avgPositionalDamageShare: round1(average(list.map((row) => metric(row, "positionalDamageShare")))),
    avgDamageTakenPerMinute: Math.round(average(list.map((row) => metric(row, "damageTakenPerMinute")))),
    damageTakenShareValidCount: list.filter((row) => metric(row, "damageTakenShare") > 0).length,
    avgDamageTakenShare: round1(average(list.map((row) => metric(row, "damageTakenShare")))),
    avgShieldReceivedPerMinute: Math.round(average(list.map((row) => metric(row, "shieldReceivedPerMinute")))),
    avgStaggerPerMinute: Math.round(average(list.map((row) => metric(row, "staggerPerMinute")))),
    avgIncapacitations: round2(average(list.map((row) => metric(row, "incapacitations")))),
    avgIncapacitationsPerMinute: round2(average(list.map((row) => metric(row, "incapacitationsPerMinute")))),
    avgHyperShare: round1(average(list.map((row) => metric(row, "hyperShare")))),
    avgUnbuffedShare: round1(average(list.map((row) => metric(row, "unbuffedShare")))),
    avgSupportBuffedShare: round1(average(list.map((row) => metric(row, "supportBuffedShare")))),
    avgSupportDebuffedShare: round1(average(list.map((row) => metric(row, "supportDebuffedShare")))),
    avgPartyBuffedShare: round1(average(list.map((row) => metric(row, "partyBuffedShare")))),
    avgSelfBuffedShare: round1(average(list.map((row) => metric(row, "selfBuffedShare")))),
    avgPartyDebuffedShare: round1(average(list.map((row) => metric(row, "partyDebuffedShare")))),
    avgBattleItemDebuffedShare: round1(average(list.map((row) => metric(row, "battleItemDebuffedShare")))),
    avgSkillCount: round1(average(list.map((row) => metric(row, "skillCount")))),
    avgTopSkillShare: round1(average(list.map((row) => metric(row, "topSkillShare")))),
    avgRdpsDamageGivenPerMinute: Math.round(average(rdpsRows.map((row) => metric(row, "rdpsDamageGivenPerMinute")))),
    avgRdpsDamageReceivedSupportPerMinute: Math.round(average(rdpsRows.map((row) => metric(row, "rdpsDamageReceivedSupportPerMinute")))),
    avgSynergyGivenPerMinute: Math.round(average(list.map((row) => metric(row, "synergyGivenPerMinute")))),
    avgSynergyGivenShare: round1(average(list.map((row) => metric(row, "synergyGivenShare")))),
    avgSynergyReceivedShare: round1(average(list.map((row) => metric(row, "synergyReceivedShare")))),
    avgSupportAp: round2(average(list.map((row) => metric(row, "supportAp")))),
    avgSupportBrand: round2(average(list.map((row) => metric(row, "supportBrand")))),
    avgSupportIdentity: round2(average(list.map((row) => metric(row, "supportIdentity")))),
    avgSupportHyper: round2(average(list.map((row) => metric(row, "supportHyper")))),
    avgProtectionPerMinute: Math.round(average(list.map((row) => metric(row, "protectionPerMinute")))),
    avgGearScore: round2(average(list.map((row) => Number(row?.build?.gearScore) || 0).filter((n) => n > 0))),
    latestGearScore: round2(latestSummary(list)?.build?.gearScore),
    avgCombatPower: round2(average(list.map((row) => Number(row?.build?.combatPower) || 0).filter((n) => n > 0))),
    latestCombatPower: round2(latestSummary(list)?.build?.combatPower),
    arkPassiveRate: arkRows.length ? round1((arkRows.filter((row) => row?.build?.arkPassiveActive === true).length / arkRows.length) * 100) : 0,
    buildVariantCount: Math.max(1, buildSpecs.size),
    consistency: round1(consistencyScore(role === "support"
      ? supporterRows.map((row) => metric(row, "supporterPercent"))
      : list.map((row) => metric(row, "damageShare")))),
  };
  stats.radiantSupportRate = round1(supporterRows.length ? (stats.radiantSupportCount / supporterRows.length) * 100 : 0);
  stats.supporterTopRate = round1(supporterCompetitiveRows.length
    ? (supporterCompetitiveRows.filter((row) => metric(row, "supporterRank") === 1).length / supporterCompetitiveRows.length) * 100
    : 0);
  return stats;
}

function mergeStats(target, derived) {
  const out = target && typeof target === "object" ? target : {};
  for (const [key, value] of Object.entries(derived || {})) {
    const current = out[key];
    const currentNumber = Number(current);
    const derivedNumber = Number(value);
    if (
      current === undefined ||
      current === null ||
      current === "" ||
      (Number.isFinite(currentNumber) && currentNumber === 0 && Number.isFinite(derivedNumber) && derivedNumber > 0)
    ) {
      out[key] = value;
    }
  }
  return out;
}

function isMissingBuild(build) {
  return !build || typeof build !== "object" || !String(build.spec || "").trim();
}

function hydrateAltBuildsFromEncounterSummaries(accounts, summaries) {
  if (!Array.isArray(accounts) || !Array.isArray(summaries) || summaries.length === 0) return accounts;
  const byCharacter = new Map();
  for (const summary of summaries) {
    const key = `${normalizeKey(summary.accountName)}\x1f${normalizeKey(summary.characterName)}`;
    if (!byCharacter.has(key)) byCharacter.set(key, []);
    byCharacter.get(key).push(summary);
  }

  for (const account of accounts) {
    for (const character of account.characters || []) {
      const alt = character?.altBuild;
      if (!alt?.role) continue;
      const key = `${normalizeKey(account.accountName)}\x1f${normalizeKey(character.name)}`;
      const rows = (byCharacter.get(key) || []).filter((summary) => summary.role === alt.role);
      if (!rows.length) continue;
      alt.encounters = Number(alt.encounters) || rows.length;
      alt.stats = mergeStats(alt.stats, deriveStatsFromSummaries(rows, alt.role));
      if (isMissingBuild(alt.build)) {
        alt.build = latestSummary(rows)?.build || {};
      }
    }
  }
  return accounts;
}

module.exports = {
  deriveStatsFromSummaries,
  hydrateAltBuildsFromEncounterSummaries,
};
