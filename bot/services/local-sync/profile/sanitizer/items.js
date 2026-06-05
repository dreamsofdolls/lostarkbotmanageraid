"use strict";

const {
  clampNumber,
  cleanAttackStyle,
  cleanRole,
  cleanShortString,
} = require("./common");

function cleanRaidBreakdown(raw) {
  if (!raw || typeof raw !== "object") return null;
  const raidKey = cleanShortString(raw.raidKey, 32);
  const modeKey = cleanShortString(raw.modeKey, 32);
  if (!raidKey || !modeKey) return null;
  return {
    raidKey,
    modeKey,
    boss: cleanShortString(raw.boss, 120),
    encounters: clampNumber(raw.encounters, { max: 100000 }),
    firstFightStart: clampNumber(raw.firstFightStart, { max: 9999999999999, fallback: null }),
    lastFightStart: clampNumber(raw.lastFightStart, { max: 9999999999999, fallback: null }),
    avgDurationMs: clampNumber(raw.avgDurationMs, { max: 24 * 60 * 60 * 1000 }),
    avgActiveDurationMs: clampNumber(raw.avgActiveDurationMs, { max: 24 * 60 * 60 * 1000 }),
    avgIntermissionMs: clampNumber(raw.avgIntermissionMs, { max: 24 * 60 * 60 * 1000 }),
    avgActiveTimeRate: clampNumber(raw.avgActiveTimeRate, { max: 100 }),
    avgDps: clampNumber(raw.avgDps),
    medianDps: clampNumber(raw.medianDps),
    avgPeak10sDps: clampNumber(raw.avgPeak10sDps),
    p90Peak10sDps: clampNumber(raw.p90Peak10sDps),
    avgBurstRatio: clampNumber(raw.avgBurstRatio, { max: 100 }),
    avgDamageShare: clampNumber(raw.avgDamageShare, { max: 100 }),
    avgTopDamageProximity: clampNumber(raw.avgTopDamageProximity, { max: 100 }),
    contextCoverageRate: clampNumber(raw.contextCoverageRate, { max: 100 }),
    contextSampleCountAvg: clampNumber(raw.contextSampleCountAvg, { max: 100000 }),
    avgContextPerformancePercentile: clampNumber(raw.avgContextPerformancePercentile, { max: 100 }),
    avgContextDamageSharePercentile: clampNumber(raw.avgContextDamageSharePercentile, { max: 100 }),
    avgContextTopDamageProximityPercentile: clampNumber(raw.avgContextTopDamageProximityPercentile, { max: 100 }),
    avgContextSupportPercentile: clampNumber(raw.avgContextSupportPercentile, { max: 100 }),
    topRate: clampNumber(raw.topRate, { max: 100 }),
    deathlessRate: clampNumber(raw.deathlessRate, { max: 100 }),
    deathRate: clampNumber(raw.deathRate, { max: 100 }),
    totalDeaths: clampNumber(raw.totalDeaths, { max: 100000 }),
    avgDeaths: clampNumber(raw.avgDeaths, { max: 1000 }),
    totalDeadTimeMs: clampNumber(raw.totalDeadTimeMs, { max: 9999999999999 }),
    avgDeadTimeMs: clampNumber(raw.avgDeadTimeMs, { max: 9999999999999 }),
    avgDeadTimeRate: clampNumber(raw.avgDeadTimeRate, { max: 100 }),
    rdpsValidCount: clampNumber(raw.rdpsValidCount, { max: 100000 }),
    rdpsValidRate: clampNumber(raw.rdpsValidRate, { max: 100 }),
    avgSupporterPercent: clampNumber(raw.avgSupporterPercent, { max: 100 }),
    medianSupporterPercent: clampNumber(raw.medianSupporterPercent, { max: 100 }),
    radiantSupportCount: clampNumber(raw.radiantSupportCount, { max: 100000 }),
    radiantSupportRate: clampNumber(raw.radiantSupportRate, { max: 100 }),
    avgSupporterDamageGivenPerMinute: clampNumber(raw.avgSupporterDamageGivenPerMinute),
    supporterRankValidCount: clampNumber(raw.supporterRankValidCount, { max: 100000 }),
    supporterCompetitiveCount: clampNumber(raw.supporterCompetitiveCount, { max: 100000 }),
    avgSupporterRank: clampNumber(raw.avgSupporterRank, { max: 1000 }),
    supporterCountAvg: clampNumber(raw.supporterCountAvg, { max: 1000 }),
    supporterTopRate: clampNumber(raw.supporterTopRate, { max: 100 }),
    avgCritRate: clampNumber(raw.avgCritRate, { max: 100 }),
    avgCritDamageShare: clampNumber(raw.avgCritDamageShare, { max: 100 }),
    avgBackAttackRate: clampNumber(raw.avgBackAttackRate, { max: 100 }),
    avgFrontAttackRate: clampNumber(raw.avgFrontAttackRate, { max: 100 }),
    avgBackAttackDamageShare: clampNumber(raw.avgBackAttackDamageShare, { max: 100 }),
    avgFrontAttackDamageShare: clampNumber(raw.avgFrontAttackDamageShare, { max: 100 }),
    avgPositionalDamageShare: clampNumber(raw.avgPositionalDamageShare, { max: 100 }),
    attackStyle: cleanAttackStyle(raw.attackStyle),
    avgDamageTakenPerMinute: clampNumber(raw.avgDamageTakenPerMinute),
    damageTakenShareValidCount: clampNumber(raw.damageTakenShareValidCount, { max: 100000 }),
    avgDamageTakenShare: clampNumber(raw.avgDamageTakenShare, { max: 100 }),
    avgShieldReceivedPerMinute: clampNumber(raw.avgShieldReceivedPerMinute),
    avgStaggerPerMinute: clampNumber(raw.avgStaggerPerMinute),
    avgIncapacitations: clampNumber(raw.avgIncapacitations, { max: 1000 }),
    avgIncapacitationsPerMinute: clampNumber(raw.avgIncapacitationsPerMinute, { max: 1000 }),
    avgHyperShare: clampNumber(raw.avgHyperShare, { max: 100 }),
    avgUnbuffedDps: clampNumber(raw.avgUnbuffedDps),
    avgSupportBuffedShare: clampNumber(raw.avgSupportBuffedShare, { max: 999 }),
    avgSupportDebuffedShare: clampNumber(raw.avgSupportDebuffedShare, { max: 999 }),
    avgPartyBuffedShare: clampNumber(raw.avgPartyBuffedShare, { max: 999 }),
    avgSelfBuffedShare: clampNumber(raw.avgSelfBuffedShare, { max: 999 }),
    avgPartyDebuffedShare: clampNumber(raw.avgPartyDebuffedShare, { max: 999 }),
    avgBattleItemDebuffedShare: clampNumber(raw.avgBattleItemDebuffedShare, { max: 999 }),
    avgSynergyGivenPerMinute: clampNumber(raw.avgSynergyGivenPerMinute),
    avgSynergyReceivedShare: clampNumber(raw.avgSynergyReceivedShare, { max: 100 }),
    avgSkillCount: clampNumber(raw.avgSkillCount, { max: 1000 }),
    avgTopSkillShare: clampNumber(raw.avgTopSkillShare, { max: 100 }),
    avgProtectionPerMinute: clampNumber(raw.avgProtectionPerMinute),
    avgGearScore: clampNumber(raw.avgGearScore, { max: 9999 }),
    avgCombatPower: clampNumber(raw.avgCombatPower),
    arkPassiveRate: clampNumber(raw.arkPassiveRate, { max: 100 }),
  };
}

function cleanTopSkill(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanShortString(raw.name, 80);
  if (!name) return null;
  return {
    id: cleanShortString(raw.id, 32),
    name,
    damage: clampNumber(raw.damage),
    share: clampNumber(raw.share, { max: 100 }),
    casts: clampNumber(raw.casts, { max: 100000 }),
    hits: clampNumber(raw.hits, { max: 1000000 }),
    critRate: clampNumber(raw.critRate, { max: 100 }),
    backAttackRate: clampNumber(raw.backAttackRate, { max: 100 }),
    frontAttackRate: clampNumber(raw.frontAttackRate, { max: 100 }),
    stagger: clampNumber(raw.stagger),
    isHyperAwakening: !!raw.isHyperAwakening,
  };
}

function cleanTopSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanShortString(raw.name, 80);
  if (!name) return null;
  return {
    id: cleanShortString(raw.id, 32),
    name,
    category: cleanShortString(raw.category, 32) || "unknown",
    target: cleanShortString(raw.target, 16) || "UNKNOWN",
    amount: clampNumber(raw.amount),
    share: clampNumber(raw.share, { max: 999 }),
  };
}

function cleanBuildVariant(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanShortString(raw.name || raw.spec, 80);
  if (!name) return null;
  return {
    name,
    spec: cleanShortString(raw.spec || name, 80),
    role: cleanRole(raw.role),
    encounters: clampNumber(raw.encounters, { max: 100000 }),
    firstFightStart: clampNumber(raw.firstFightStart, { max: 9999999999999, fallback: null }),
    lastFightStart: clampNumber(raw.lastFightStart, { max: 9999999999999, fallback: null }),
    avgDps: clampNumber(raw.avgDps),
    medianDps: clampNumber(raw.medianDps),
    p90Dps: clampNumber(raw.p90Dps),
    avgRdps: clampNumber(raw.avgRdps),
    medianRdps: clampNumber(raw.medianRdps),
    avgNdps: clampNumber(raw.avgNdps),
    medianNdps: clampNumber(raw.medianNdps),
    avgDamageShare: clampNumber(raw.avgDamageShare, { max: 100 }),
    avgTopDamageProximity: clampNumber(raw.avgTopDamageProximity, { max: 100 }),
    avgBiblePercentile: clampNumber(raw.avgBiblePercentile, { max: 100 }),
    avgOverallBiblePercentile: clampNumber(raw.avgOverallBiblePercentile, { max: 100 }),
    avgContextPerformancePercentile: clampNumber(raw.avgContextPerformancePercentile, { max: 100 }),
    avgCritRate: clampNumber(raw.avgCritRate, { max: 100 }),
    avgBackAttackDamageShare: clampNumber(raw.avgBackAttackDamageShare, { max: 100 }),
    avgFrontAttackDamageShare: clampNumber(raw.avgFrontAttackDamageShare, { max: 100 }),
  };
}

module.exports = {
  cleanBuildVariant,
  cleanRaidBreakdown,
  cleanTopSkill,
  cleanTopSource,
};
