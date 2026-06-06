"use strict";

import {
  getRaidGateForBoss,
  normalizeDifficulty,
} from "/sync/js/sync/preview-utils.js";
import {
  average,
  buildVariantKey,
  classifyAttackStyle,
  cleanBuildName,
  countUnclassifiedBuildRows,
  enrichProfileRows,
  isModernProfileRow,
  maxPositive,
  minPositive,
  normalizeName,
  percentile,
  summarizeBuildVariants,
} from "/sync/js/profile/data/profile-row-enrich.js";
import { computeProfileConsistency } from "/sync/js/profile/metrics/profile-metrics.js";
import { computeProfileScores as computeScores, MIN_CONTEXT_SAMPLE_COUNT } from "/sync/js/profile/metrics/profile-score.js";
import { roleForProfileClass } from "/sync/js/profile/profile-role.js";

const MAX_PROFILE_ENCOUNTER_SUMMARIES = 5000;
const MIN_DURATION_MS = 180000;

function summarizeGroup(rows) {
  const dps = rows.map((r) => r.dps);
  const peak10sDps = rows.map((r) => r.peak10sDps).filter((n) => n > 0);
  const burstRatios = rows.map((r) => r.burstRatio).filter((n) => n > 0);
  const shares = rows.map((r) => r.partyDps > 0 ? (r.dps / r.partyDps) * 100 : 0);
  const ranks = rows.map((r) => r.damageRank).filter((n) => n > 0);
  const protectionPerMinute = rows.map((r) => r.protectionPerMinute);
  const damageRows = rows.filter((r) => r.hasDamageStats);
  const deathCounts = rows.map((r) => Number(r.deathCount) || 0);
  const totalDeaths = deathCounts.reduce((sum, n) => sum + n, 0);
  const deathRows = deathCounts.filter((n) => n > 0).length;
  const deadTimes = rows.map((r) => Number(r.deadTimeMs) || 0);
  const totalDeadTimeMs = deadTimes.reduce((sum, n) => sum + n, 0);
  const damageTakenShareRows = damageRows.filter((r) => r.damageTakenShareValid);
  const rdpsRows = rows.filter((r) => r.rdpsValid);
  const rdpsValidCount = rdpsRows.length;
  const supporterRows = rdpsRows.length ? rdpsRows : rows;
  const supporterPercents = supporterRows.map((r) => Number(r.supporterPercent) || 0);
  const radiantSupportCount = supporterRows.filter((r) => r.supporterTier === "radiant").length;
  const supporterRankRows = supporterRows.filter((r) => (Number(r.supporterRank) || 0) > 0 && (Number(r.supporterCount) || 0) > 0);
  const supporterCompetitiveRows = supporterRankRows.filter((r) => (Number(r.supporterCount) || 0) > 1);
  const contextRows = rows.filter((r) => (Number(r.contextSampleCount) || 0) >= MIN_CONTEXT_SAMPLE_COUNT && r.contextSource !== "none");
  const dpsContextRows = contextRows.filter((r) => r.logRole !== "support");
  const supportContextRows = contextRows.filter((r) => r.logRole === "support");
  const avgBackAttackRate = round1(average(rows.map((r) => r.backAttackRate)));
  const avgFrontAttackRate = round1(average(rows.map((r) => r.frontAttackRate)));
  const avgBackAttackDamageShare = round1(average(rows.map((r) => r.backAttackDamageShare)));
  const avgFrontAttackDamageShare = round1(average(rows.map((r) => r.frontAttackDamageShare)));
  const arkRows = rows.filter((r) => r.arkPassiveActive !== null);
  return {
    encounters: rows.length,
    firstFightStart: minPositive(rows.map((r) => r.fightStart)),
    lastFightStart: maxPositive(rows.map((r) => r.fightStart)),
    avgDurationMs: Math.round(average(rows.map((r) => r.durationMs))),
    avgActiveDurationMs: Math.round(average(rows.map((r) => r.activeDurationMs))),
    avgIntermissionMs: Math.round(average(rows.map((r) => r.intermissionMs))),
    avgActiveTimeRate: round1(average(rows.map((r) => r.activeTimeRate))),
    avgDps: Math.round(average(dps)),
    medianDps: Math.round(percentile(dps, 50)),
    avgPeak10sDps: Math.round(average(peak10sDps)),
    p90Peak10sDps: Math.round(percentile(peak10sDps, 90)),
    avgBurstRatio: round2(average(burstRatios)),
    avgDamageShare: round1(average(shares)),
    avgTopDamageProximity: round1(average(rows.map((r) => r.topDamageProximity))),
    contextCoverageRate: round1((contextRows.length / rows.length) * 100),
    contextSampleCountAvg: round1(average(contextRows.map((r) => r.contextSampleCount))),
    avgContextPerformancePercentile: round1(average(contextRows.map((r) => r.contextPerformancePercentile))),
    avgContextDamageSharePercentile: round1(average(dpsContextRows.map((r) => r.contextDamageSharePercentile))),
    avgContextTopDamageProximityPercentile: round1(average(dpsContextRows.map((r) => r.contextTopDamageProximityPercentile))),
    avgContextSupportPercentile: round1(average(supportContextRows.map((r) => r.contextSupportPercentile))),
    topRate: round1((rows.filter((r) => r.damageRank === 1).length / rows.length) * 100),
    avgRank: round2(average(ranks)),
    deathlessRate: round1(((rows.length - deathRows) / rows.length) * 100),
    deathRate: round1((deathRows / rows.length) * 100),
    totalDeaths,
    avgDeaths: round2(average(deathCounts)),
    totalDeadTimeMs: Math.round(totalDeadTimeMs),
    avgDeadTimeMs: Math.round(average(deadTimes)),
    avgDeadTimeRate: round1(average(rows.map((r) => r.deadTimeRate))),
    rdpsValidCount,
    rdpsValidRate: round1((rdpsValidCount / rows.length) * 100),
    avgSupporterPercent: round1(average(supporterPercents)),
    medianSupporterPercent: round1(percentile(supporterPercents, 50)),
    radiantSupportCount,
    radiantSupportRate: round1(supporterRows.length ? (radiantSupportCount / supporterRows.length) * 100 : 0),
    avgSupporterDamageGivenPerMinute: Math.round(average(supporterRows.map((r) => r.supporterDamageGivenPerMinute))),
    supporterRankValidCount: supporterRankRows.length,
    supporterCompetitiveCount: supporterCompetitiveRows.length,
    avgSupporterRank: round2(average(supporterRankRows.map((r) => r.supporterRank))),
    supporterCountAvg: round2(average(supporterRankRows.map((r) => r.supporterCount))),
    supporterTopRate: round1(supporterCompetitiveRows.length
      ? (supporterCompetitiveRows.filter((r) => r.supporterRank === 1).length / supporterCompetitiveRows.length) * 100
      : 0),
    avgCritRate: round1(average(rows.map((r) => r.critRate))),
    avgCritDamageShare: round1(average(rows.map((r) => r.critDamageShare))),
    avgBackAttackRate,
    avgFrontAttackRate,
    avgBackAttackDamageShare,
    avgFrontAttackDamageShare,
    avgPositionalDamageShare: round1(average(rows.map((r) => r.positionalDamageShare))),
    attackStyle: classifyAttackStyle(avgBackAttackDamageShare || avgBackAttackRate, avgFrontAttackDamageShare || avgFrontAttackRate),
    avgDamageTakenPerMinute: Math.round(average(damageRows.map((r) => r.damageTakenPerMinute))),
    damageTakenShareValidCount: damageTakenShareRows.length,
    avgDamageTakenShare: round1(average(damageTakenShareRows.map((r) => r.damageTakenShare))),
    avgShieldReceivedPerMinute: Math.round(average(damageRows.map((r) => r.shieldReceivedPerMinute))),
    avgStaggerPerMinute: Math.round(average(damageRows.map((r) => r.staggerPerMinute))),
    avgIncapacitations: round2(average(damageRows.map((r) => r.incapacitations))),
    avgIncapacitationsPerMinute: round2(average(damageRows.map((r) => r.incapacitationsPerMinute))),
    avgHyperShare: round1(average(damageRows.map((r) => r.hyperShare))),
    avgUnbuffedDps: Math.round(average(damageRows.map((r) => r.unbuffedDps).filter((n) => n > 0))),
    avgSupportBuffedShare: round1(average(damageRows.map((r) => r.supportBuffedShare))),
    avgSupportDebuffedShare: round1(average(damageRows.map((r) => r.supportDebuffedShare))),
    avgPartyBuffedShare: round1(average(damageRows.map((r) => r.partyBuffedShare))),
    avgSelfBuffedShare: round1(average(damageRows.map((r) => r.selfBuffedShare))),
    avgPartyDebuffedShare: round1(average(damageRows.map((r) => r.partyDebuffedShare))),
    avgBattleItemDebuffedShare: round1(average(damageRows.map((r) => r.battleItemDebuffedShare))),
    avgSynergyGivenPerMinute: Math.round(average(rows.map((r) => r.synergyGivenPerMinute))),
    avgSynergyReceivedShare: round1(average(rows.map((r) => r.synergyReceivedShare))),
    avgSkillCount: round1(average(rows.map((r) => r.skillCount))),
    avgTopSkillShare: round1(average(rows.map((r) => r.topSkillShare))),
    avgProtectionPerMinute: Math.round(average(protectionPerMinute)),
    avgGearScore: round2(average(rows.map((r) => r.gearScore).filter((n) => n > 0))),
    avgCombatPower: round2(average(rows.map((r) => r.combatPower).filter((n) => n > 0))),
    arkPassiveRate: arkRows.length
      ? round1((arkRows.filter((r) => r.arkPassiveActive).length / arkRows.length) * 100)
      : 0,
  };
}

function mergeTopSkills(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    for (const skill of row.topSkills || []) {
      const key = skill.id || normalizeName(skill.name);
      if (!key) continue;
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: skill.id || "",
          name: skill.name || "Unknown",
          damage: 0,
          casts: 0,
          hits: 0,
          critHits: 0,
          backHits: 0,
          frontHits: 0,
          stagger: 0,
          isHyperAwakening: !!skill.isHyperAwakening,
        });
      }
      const entry = byKey.get(key);
      const hits = Number(skill.hits) || 0;
      entry.damage += Number(skill.damage) || 0;
      entry.casts += Number(skill.casts) || 0;
      entry.hits += hits;
      entry.critHits += hits * ((Number(skill.critRate) || 0) / 100);
      entry.backHits += hits * ((Number(skill.backAttackRate) || 0) / 100);
      entry.frontHits += hits * ((Number(skill.frontAttackRate) || 0) / 100);
      entry.stagger += Number(skill.stagger) || 0;
      entry.isHyperAwakening = entry.isHyperAwakening || !!skill.isHyperAwakening;
    }
  }

  const totalDamage = [...byKey.values()].reduce((sum, skill) => sum + skill.damage, 0);
  return [...byKey.values()]
    .sort((a, b) => b.damage - a.damage || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      damage: Math.round(skill.damage),
      share: totalDamage > 0 ? round1((skill.damage / totalDamage) * 100) : 0,
      casts: Math.round(skill.casts),
      hits: Math.round(skill.hits),
      critRate: skill.hits > 0 ? round1((skill.critHits / skill.hits) * 100) : 0,
      backAttackRate: skill.hits > 0 ? round1((skill.backHits / skill.hits) * 100) : 0,
      frontAttackRate: skill.hits > 0 ? round1((skill.frontHits / skill.hits) * 100) : 0,
      stagger: Math.round(skill.stagger),
      isHyperAwakening: !!skill.isHyperAwakening,
    }));
}

function mergeTopSources(rows, field, denominatorFn, limit = 6) {
  const byKey = new Map();
  let denominator = 0;
  for (const row of rows || []) {
    denominator += Math.max(0, Number(denominatorFn(row)) || 0);
    for (const source of row[field] || []) {
      const key = source.id || `${source.category}\x1f${source.target}\x1f${normalizeName(source.name)}`;
      if (!key) continue;
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: source.id || "",
          name: source.name || "Unknown",
          category: source.category || "unknown",
          target: source.target || "UNKNOWN",
          amount: 0,
        });
      }
      byKey.get(key).amount += Number(source.amount) || 0;
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((source) => ({
      id: source.id,
      name: source.name,
      category: source.category,
      target: source.target,
      amount: Math.round(source.amount),
      share: denominator > 0 ? round1((source.amount / denominator) * 100) : 0,
    }));
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function buildProfileSnapshot(rows, rosterAccounts, file, {
  range = null,
  minDurationMs = MIN_DURATION_MS,
} = {}) {
  const byChar = new Map();
  for (const row of rows) {
    const key = normalizeName(row.localPlayer);
    if (!byChar.has(key)) byChar.set(key, []);
    byChar.get(key).push(row);
  }

  const accountsByName = new Map();
  for (const [, allCharRows] of byChar) {
    const classRole = roleForProfileClass(allCharRows[0]?.className);
    const supportRows = allCharRows.filter((row) => row.logRole === "support");
    const dpsBuildRows = allCharRows.filter((row) => row.logRole === "dps");
    const role = classRole === "support"
      ? (supportRows.length >= dpsBuildRows.length ? "support" : "dps")
      : classRole;
    const charRows = classRole === "support"
      ? (role === "support" ? supportRows : dpsBuildRows)
      : allCharRows;
    const profileRows = charRows.length ? charRows : allCharRows;
    const sample = profileRows[0];
    const latestRow = profileRows.reduce((best, row) => ((row.fightStart || 0) > (best.fightStart || 0) ? row : best), sample);
    const dps = profileRows.map((r) => r.dps);
    const peak10sDps = profileRows.map((r) => r.peak10sDps).filter((n) => n > 0);
    const burstRatios = profileRows.map((r) => r.burstRatio).filter((n) => n > 0);
    const rdps = profileRows.map((r) => r.rdps);
    const ndps = profileRows.map((r) => r.ndps);
    const shares = profileRows.map((r) => r.damageShare);
    const ranks = profileRows.map((r) => r.damageRank).filter((n) => n > 0);
    const counters = profileRows.map((r) => r.counters);
    const damageRows = profileRows.filter((r) => r.hasDamageStats);
    const protections = profileRows.map((r) => r.protection);
    const protectionPerMinute = profileRows.map((r) => r.protectionPerMinute);
    const deathCounts = profileRows.map((r) => Number(r.deathCount) || 0);
    const totalDeaths = deathCounts.reduce((sum, n) => sum + n, 0);
    const deathRows = deathCounts.filter((n) => n > 0).length;
    const deadTimes = profileRows.map((r) => Number(r.deadTimeMs) || 0);
    const totalDeadTimeMs = deadTimes.reduce((sum, n) => sum + n, 0);
    const damageTakenShareRows = damageRows.filter((r) => r.damageTakenShareValid);
    const rdpsValidRows = profileRows.filter((r) => r.rdpsValid);
    const rdpsValidCount = rdpsValidRows.length;
    const supporterRows = rdpsValidRows.length ? rdpsValidRows : profileRows;
    const supporterPercents = supporterRows.map((r) => Number(r.supporterPercent) || 0);
    const radiantSupportCount = supporterRows.filter((r) => r.supporterTier === "radiant").length;
    const supporterRankRows = supporterRows.filter((r) => (Number(r.supporterRank) || 0) > 0 && (Number(r.supporterCount) || 0) > 0);
    const supporterCompetitiveRows = supporterRankRows.filter((r) => (Number(r.supporterCount) || 0) > 1);
    const contextRows = profileRows.filter((r) => (Number(r.contextSampleCount) || 0) >= MIN_CONTEXT_SAMPLE_COUNT && r.contextSource !== "none");
    const dpsContextRows = contextRows.filter((r) => r.logRole !== "support");
    const supportContextRows = contextRows.filter((r) => r.logRole === "support");
    const avgBackAttackRate = round1(average(profileRows.map((r) => r.backAttackRate)));
    const avgFrontAttackRate = round1(average(profileRows.map((r) => r.frontAttackRate)));
    const avgBackAttackDamageShare = round1(average(profileRows.map((r) => r.backAttackDamageShare)));
    const avgFrontAttackDamageShare = round1(average(profileRows.map((r) => r.frontAttackDamageShare)));
    const topSkills = mergeTopSkills(profileRows);
    const topBuffSources = mergeTopSources(profileRows, "topBuffSources", (r) => r.damageDealt);
    const topDebuffSources = mergeTopSources(profileRows, "topDebuffSources", (r) => r.damageDealt);
    const topShieldGivenSources = mergeTopSources(profileRows, "topShieldGivenSources", (r) => r.protection);
    const topShieldReceivedSources = mergeTopSources(
      profileRows,
      "topShieldReceivedSources",
      (r) => r.shieldsReceived + r.damageAbsorbed
    );
    const arkRows = profileRows.filter((r) => r.arkPassiveActive !== null);
    const buildVariantKeys = new Set(profileRows.map(buildVariantKey).filter(Boolean));
    const buildVariants = summarizeBuildVariants(profileRows);
    const unclassifiedBuildLogCount = countUnclassifiedBuildRows(profileRows);
    const stats = {
      encounters: profileRows.length,
      allEncounterCount: allCharRows.length,
      supportLogCount: supportRows.length,
      dpsBuildLogCount: classRole === "support" ? dpsBuildRows.length : 0,
      supportLogRate: allCharRows.length ? round1((supportRows.length / allCharRows.length) * 100) : 0,
      dpsBuildLogRate: classRole === "support" && allCharRows.length
        ? round1((dpsBuildRows.length / allCharRows.length) * 100)
        : 0,
      primaryRoleRate: allCharRows.length ? round1((profileRows.length / allCharRows.length) * 100) : 0,
      firstFightStart: minPositive(profileRows.map((r) => r.fightStart)),
      lastFightStart: maxPositive(profileRows.map((r) => r.fightStart)),
      avgDurationMs: Math.round(average(profileRows.map((r) => r.durationMs))),
      avgActiveDurationMs: Math.round(average(profileRows.map((r) => r.activeDurationMs))),
      avgIntermissionMs: Math.round(average(profileRows.map((r) => r.intermissionMs))),
      avgActiveTimeRate: round1(average(profileRows.map((r) => r.activeTimeRate))),
      avgDps: Math.round(average(dps)),
      medianDps: Math.round(percentile(dps, 50)),
      p75Dps: Math.round(percentile(dps, 75)),
      p90Dps: Math.round(percentile(dps, 90)),
      avgPeak10sDps: Math.round(average(peak10sDps)),
      p90Peak10sDps: Math.round(percentile(peak10sDps, 90)),
      avgBurstRatio: round2(average(burstRatios)),
      avgRdps: Math.round(average(rdps)),
      medianRdps: Math.round(percentile(rdps, 50)),
      avgNdps: Math.round(average(ndps)),
      medianNdps: Math.round(percentile(ndps, 50)),
      avgDamageShare: round1(average(shares)),
      medianDamageShare: round1(percentile(shares, 50)),
      avgTopDamageProximity: round1(average(profileRows.map((r) => r.topDamageProximity))),
      contextCoverageRate: round1((contextRows.length / profileRows.length) * 100),
      contextSampleCountAvg: round1(average(contextRows.map((r) => r.contextSampleCount))),
      avgContextPerformancePercentile: round1(average(contextRows.map((r) => r.contextPerformancePercentile))),
      avgContextDamageSharePercentile: round1(average(dpsContextRows.map((r) => r.contextDamageSharePercentile))),
      avgContextTopDamageProximityPercentile: round1(average(dpsContextRows.map((r) => r.contextTopDamageProximityPercentile))),
      avgContextSupportPercentile: round1(average(supportContextRows.map((r) => r.contextSupportPercentile))),
      topRate: round1((profileRows.filter((r) => r.damageRank === 1).length / profileRows.length) * 100),
      avgRank: round2(average(ranks)),
      partyCountAvg: round2(average(profileRows.map((r) => r.partyCount).filter((n) => n > 0))),
      deathlessRate: round1(((profileRows.length - deathRows) / profileRows.length) * 100),
      deathRate: round1((deathRows / profileRows.length) * 100),
      totalDeaths,
      avgDeaths: round2(average(deathCounts)),
      totalDeadTimeMs: Math.round(totalDeadTimeMs),
      avgDeadTimeMs: Math.round(average(deadTimes)),
      avgDeadTimeRate: round1(average(profileRows.map((r) => r.deadTimeRate))),
      rdpsValidCount,
      rdpsValidRate: round1((rdpsValidCount / profileRows.length) * 100),
      avgSupporterPercent: round1(average(supporterPercents)),
      medianSupporterPercent: round1(percentile(supporterPercents, 50)),
      radiantSupportCount,
      radiantSupportRate: round1(supporterRows.length ? (radiantSupportCount / supporterRows.length) * 100 : 0),
      avgSupporterDamageGivenPerMinute: Math.round(average(supporterRows.map((r) => r.supporterDamageGivenPerMinute))),
      supporterRankValidCount: supporterRankRows.length,
      supporterCompetitiveCount: supporterCompetitiveRows.length,
      avgSupporterRank: round2(average(supporterRankRows.map((r) => r.supporterRank))),
      supporterCountAvg: round2(average(supporterRankRows.map((r) => r.supporterCount))),
      supporterTopRate: round1(supporterCompetitiveRows.length
        ? (supporterCompetitiveRows.filter((r) => r.supporterRank === 1).length / supporterCompetitiveRows.length) * 100
        : 0),
      avgCounters: round2(average(counters)),
      avgCastsPerMinute: round2(average(profileRows.map((r) => r.castsPerMinute))),
      avgHitsPerMinute: round2(average(profileRows.map((r) => r.hitsPerMinute))),
      avgCritRate: round1(average(profileRows.map((r) => r.critRate))),
      avgCritDamageShare: round1(average(profileRows.map((r) => r.critDamageShare))),
      avgBackAttackRate,
      avgFrontAttackRate,
      avgBackAttackDamageShare,
      avgFrontAttackDamageShare,
      avgPositionalDamageShare: round1(average(profileRows.map((r) => r.positionalDamageShare))),
      attackStyle: classifyAttackStyle(avgBackAttackDamageShare || avgBackAttackRate, avgFrontAttackDamageShare || avgFrontAttackRate),
      avgDamageTaken: Math.round(average(damageRows.map((r) => r.damageTaken))),
      avgDamageTakenPerMinute: Math.round(average(damageRows.map((r) => r.damageTakenPerMinute))),
      damageTakenShareValidCount: damageTakenShareRows.length,
      avgDamageTakenShare: round1(average(damageTakenShareRows.map((r) => r.damageTakenShare))),
      avgDamageAbsorbedPerMinute: Math.round(average(damageRows.map((r) => r.damageAbsorbedPerMinute))),
      avgShieldReceivedPerMinute: Math.round(average(damageRows.map((r) => r.shieldReceivedPerMinute))),
      avgStagger: Math.round(average(damageRows.map((r) => r.stagger))),
      avgStaggerPerMinute: Math.round(average(damageRows.map((r) => r.staggerPerMinute))),
      avgIncapacitations: round2(average(damageRows.map((r) => r.incapacitations))),
      avgIncapacitationsPerMinute: round2(average(damageRows.map((r) => r.incapacitationsPerMinute))),
      avgHyperShare: round1(average(damageRows.map((r) => r.hyperShare))),
      avgUnbuffedShare: round1(average(damageRows.map((r) => r.unbuffedShare))),
      avgUnbuffedDps: Math.round(average(damageRows.map((r) => r.unbuffedDps).filter((n) => n > 0))),
      avgSupportBuffedShare: round1(average(damageRows.map((r) => r.supportBuffedShare))),
      avgSupportDebuffedShare: round1(average(damageRows.map((r) => r.supportDebuffedShare))),
      avgPartyBuffedShare: round1(average(damageRows.map((r) => r.partyBuffedShare))),
      avgSelfBuffedShare: round1(average(damageRows.map((r) => r.selfBuffedShare))),
      avgPartyDebuffedShare: round1(average(damageRows.map((r) => r.partyDebuffedShare))),
      avgBattleItemDebuffedShare: round1(average(damageRows.map((r) => r.battleItemDebuffedShare))),
      avgSkillCount: round1(average(profileRows.map((r) => r.skillCount))),
      avgTopSkillShare: round1(average(profileRows.map((r) => r.topSkillShare))),
      avgRdpsDamageGiven: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageGiven))),
      avgRdpsDamageGivenPerMinute: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageGivenPerMinute))),
      avgRdpsDamageReceivedSupport: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageReceivedSupport))),
      avgRdpsDamageReceivedSupportPerMinute: Math.round(average(rdpsValidRows.map((r) => r.rdpsDamageReceivedSupportPerMinute))),
      avgSynergyGiven: Math.round(average(profileRows.map((r) => r.synergyGiven))),
      avgSynergyGivenPerMinute: Math.round(average(profileRows.map((r) => r.synergyGivenPerMinute))),
      avgSynergyReceivedShare: round1(average(profileRows.map((r) => r.synergyReceivedShare))),
      avgSupportAp: round2(average(profileRows.map((r) => r.supportAp))),
      avgSupportBrand: round2(average(profileRows.map((r) => r.supportBrand))),
      avgSupportIdentity: round2(average(profileRows.map((r) => r.supportIdentity))),
      avgSupportHyper: round2(average(profileRows.map((r) => r.supportHyper))),
      avgProtection: Math.round(average(protections)),
      avgProtectionPerMinute: Math.round(average(protectionPerMinute)),
      avgGearScore: round2(average(profileRows.map((r) => r.gearScore).filter((n) => n > 0))),
      latestGearScore: round2(latestRow.gearScore),
      avgCombatPower: round2(average(profileRows.map((r) => r.combatPower).filter((n) => n > 0))),
      latestCombatPower: round2(latestRow.combatPower),
      arkPassiveRate: arkRows.length
        ? round1((arkRows.filter((r) => r.arkPassiveActive).length / arkRows.length) * 100)
        : 0,
      buildVariantCount: Math.max(buildVariantKeys.size, buildVariants.length),
      unclassifiedBuildLogCount,
      consistency: computeProfileConsistency(profileRows, role),
    };

    const build = {
      classId: latestRow.classId || 0,
      spec: cleanBuildName(latestRow.arkPassive?.enlightenment?.spec || latestRow.spec),
      gearScore: round2(latestRow.gearScore),
      combatPower: round2(latestRow.combatPower),
      arkPassiveActive: latestRow.arkPassiveActive === null ? null : !!latestRow.arkPassiveActive,
      engravings: latestRow.engravings || [],
      arkPassive: latestRow.arkPassive || null,
    };

    const raidGroups = new Map();
    for (const row of profileRows) {
      const gate = getRaidGateForBoss(row.boss);
      if (!gate) continue;
      const modeKey = normalizeDifficulty(row.difficulty) || "normal";
      const groupKey = `${gate.raidKey}\x1f${modeKey}\x1f${row.boss}`;
      if (!raidGroups.has(groupKey)) raidGroups.set(groupKey, []);
      raidGroups.get(groupKey).push(row);
    }
    const raids = [...raidGroups.values()].map((groupRows) => {
      const gate = getRaidGateForBoss(groupRows[0].boss);
      const modeKey = normalizeDifficulty(groupRows[0].difficulty) || "normal";
      return {
        raidKey: gate?.raidKey || "",
        modeKey,
        boss: groupRows[0].boss,
        ...summarizeGroup(groupRows),
      };
    }).sort((a, b) => (b.lastFightStart || 0) - (a.lastFightStart || 0));

    const accountName = sample.accountName || "";
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
      scores: computeScores(stats, role),
      build,
      topSkills,
      topBuffSources,
      topDebuffSources,
      topShieldGivenSources,
      topShieldReceivedSources,
      buildVariants,
      raids,
    });
  }

  for (const account of accountsByName.values()) {
    account.characters.sort((a, b) => b.stats.encounters - a.stats.encounters || a.name.localeCompare(b.name));
  }

  return {
    version: 1,
    generatedAt: Date.now(),
    db: {
      fileName: file?.name || "encounters.db",
      size: Number(file?.size) || 0,
      lastModified: Number(file?.lastModified) || null,
    },
    accounts: [...accountsByName.values()].sort((a, b) => a.accountName.localeCompare(b.accountName)),
    criteria: {
      clearedOnly: true,
      supportedBossesOnly: true,
      minDurationMs,
      modernProfileStatsOnly: true,
      range,
    },
  };
}

function compactEncounterArkPassive(arkPassive) {
  const compactTree = (tree = {}) => ({
    count: Number(tree.count) || 0,
    points: Number(tree.points) || 0,
    spentPoints: Number(tree.spentPoints) || 0,
    spec: cleanBuildName(tree.spec),
  });
  if (!arkPassive) return null;
  return {
    evolution: compactTree(arkPassive.evolution),
    enlightenment: compactTree(arkPassive.enlightenment),
    leap: compactTree(arkPassive.leap),
  };
}

export function buildProfileEncounterSummaries(rows, file, { range = null } = {}) {
  return (rows || []).slice(0, MAX_PROFILE_ENCOUNTER_SUMMARIES).map((row) => {
    const gate = getRaidGateForBoss(row.boss);
    if (!gate) return null;
    const modeKey = normalizeDifficulty(row.difficulty) || "normal";
    return {
      encounterId: String(row.encounterId || `${row.fightStart}:${row.localPlayer}:${row.boss}`),
      accountName: row.accountName || "",
      characterName: row.localPlayer || "",
      class: row.className || "",
      itemLevel: Number(row.itemLevel) || 0,
      classRole: row.classRole || "unknown",
      role: row.logRole || row.classRole || "unknown",
      fightStart: Number(row.fightStart) || 0,
      durationMs: Math.round(Number(row.durationMs) || 0),
      boss: row.boss || "",
      raidKey: gate.raidKey || "",
      modeKey,
      difficulty: row.difficulty || "",
      rangeType: range?.type === "weekly" ? "weekly" : "full",
      build: {
        classId: Number(row.classId) || 0,
        spec: cleanBuildName(row.arkPassive?.enlightenment?.spec || row.spec),
        gearScore: round2(row.gearScore),
        combatPower: round2(row.combatPower),
        arkPassiveActive: row.arkPassiveActive === null ? null : !!row.arkPassiveActive,
        engravings: (row.engravings || []).slice(0, 4),
        arkPassive: compactEncounterArkPassive(row.arkPassive),
      },
      metrics: {
        dps: Math.round(Number(row.dps) || 0),
        rdps: Math.round(Number(row.rdps) || 0),
        ndps: Math.round(Number(row.ndps) || 0),
        peak10sDps: Math.round(Number(row.peak10sDps) || 0),
        burstRatio: round2(row.burstRatio),
        rdpsValid: row.rdpsValid === true,
        activeDurationMs: Math.round(Number(row.activeDurationMs) || 0),
        intermissionMs: Math.round(Number(row.intermissionMs) || 0),
        activeTimeRate: round1(row.activeTimeRate),
        damageDealt: Math.round(Number(row.damageDealt) || 0),
        damageShare: round1(row.damageShare),
        topDamageProximity: round1(row.topDamageProximity),
        contextSampleCount: Number(row.contextSampleCount) || 0,
        contextSource: row.contextSource || "none",
        contextPerformancePercentile: round1(row.contextPerformancePercentile),
        contextDamageSharePercentile: round1(row.contextDamageSharePercentile),
        contextTopDamageProximityPercentile: round1(row.contextTopDamageProximityPercentile),
        contextSupportPercentile: round1(row.contextSupportPercentile),
        damageRank: Number(row.damageRank) || 0,
        partyCount: Number(row.partyCount) || 0,
        deathCount: Number(row.deathCount) || 0,
        deadTimeMs: Math.round(Number(row.deadTimeMs) || 0),
        deadTimeRate: round1(row.deadTimeRate),
        counters: Number(row.counters) || 0,
        castsPerMinute: round2(row.castsPerMinute),
        hitsPerMinute: round2(row.hitsPerMinute),
        critRate: round1(row.critRate),
        critDamageShare: round1(row.critDamageShare),
        backAttackRate: round1(row.backAttackRate),
        frontAttackRate: round1(row.frontAttackRate),
        backAttackDamageShare: round1(row.backAttackDamageShare),
        frontAttackDamageShare: round1(row.frontAttackDamageShare),
        positionalDamageShare: round1(row.positionalDamageShare),
        topSkillShare: round1(row.topSkillShare),
        damageTakenPerMinute: Math.round(Number(row.damageTakenPerMinute) || 0),
        damageTakenShare: round1(row.damageTakenShare),
        shieldReceivedPerMinute: Math.round(Number(row.shieldReceivedPerMinute) || 0),
        staggerPerMinute: Math.round(Number(row.staggerPerMinute) || 0),
        incapacitations: Number(row.incapacitations) || 0,
        incapacitationsPerMinute: round2(row.incapacitationsPerMinute),
        hyperShare: round1(row.hyperShare),
        unbuffedShare: round1(row.unbuffedShare),
        supportBuffedShare: round1(row.supportBuffedShare),
        supportDebuffedShare: round1(row.supportDebuffedShare),
        partyBuffedShare: round1(row.partyBuffedShare),
        selfBuffedShare: round1(row.selfBuffedShare),
        partyDebuffedShare: round1(row.partyDebuffedShare),
        battleItemDebuffedShare: round1(row.battleItemDebuffedShare),
        protectionPerMinute: Math.round(Number(row.protectionPerMinute) || 0),
        rdpsDamageGivenPerMinute: Math.round(Number(row.rdpsDamageGivenPerMinute) || 0),
        rdpsDamageReceivedSupportPerMinute: Math.round(Number(row.rdpsDamageReceivedSupportPerMinute) || 0),
        supporterDamageGiven: Math.round(Number(row.supporterDamageGiven) || 0),
        supporterDamageGivenPerMinute: Math.round(Number(row.supporterDamageGivenPerMinute) || 0),
        supporterPercent: round1(row.supporterPercent),
        supporterTier: row.supporterTier || "none",
        supporterRank: Number(row.supporterRank) || 0,
        supporterCount: Number(row.supporterCount) || 0,
        synergyGivenPerMinute: Math.round(Number(row.synergyGivenPerMinute) || 0),
        synergyReceivedShare: round1(row.synergyReceivedShare),
      },
      topSkills: (row.topSkills || []).slice(0, 5).map((skill) => ({
        id: String(skill.id || "").slice(0, 32),
        name: cleanBuildName(skill.name),
        damage: Math.round(Number(skill.damage) || 0),
        share: round1(skill.share),
        casts: Math.round(Number(skill.casts) || 0),
        hits: Math.round(Number(skill.hits) || 0),
        critRate: round1(skill.critRate),
        backAttackRate: round1(skill.backAttackRate),
        frontAttackRate: round1(skill.frontAttackRate),
        stagger: Math.round(Number(skill.stagger) || 0),
        isHyperAwakening: !!skill.isHyperAwakening,
      })),
    };
  }).filter(Boolean);
}

export function fingerprintSnapshot(snapshot) {
  const parts = [];
  parts.push([
    "range",
    snapshot.criteria?.range?.type || "",
    snapshot.criteria?.range?.minFightStartMs || 0,
  ].join(":"));
  for (const account of snapshot.accounts || []) {
    for (const character of account.characters || []) {
      const stats = character.stats || {};
      const scores = character.scores || {};
      parts.push([
        "char",
        account.accountName,
        character.name,
        character.role || "",
        stats.encounters || 0,
        stats.lastFightStart || 0,
        stats.avgDps || 0,
        stats.medianDps || 0,
        stats.buildVariantCount || 0,
        stats.unclassifiedBuildLogCount || 0,
        stats.avgPeak10sDps || 0,
        stats.p90Peak10sDps || 0,
        stats.avgBurstRatio || 0,
        stats.avgDamageShare || 0,
        stats.avgTopDamageProximity || 0,
        stats.contextCoverageRate || 0,
        stats.contextSampleCountAvg || 0,
        stats.avgContextPerformancePercentile || 0,
        stats.avgContextDamageSharePercentile || 0,
        stats.avgContextTopDamageProximityPercentile || 0,
        stats.avgContextSupportPercentile || 0,
        stats.avgSupporterPercent || 0,
        stats.radiantSupportRate || 0,
        stats.avgSupporterRank || 0,
        stats.supporterCountAvg || 0,
        stats.supporterTopRate || 0,
        stats.avgCritDamageShare || 0,
        stats.avgBackAttackDamageShare || 0,
        stats.avgFrontAttackDamageShare || 0,
        stats.avgPositionalDamageShare || 0,
        stats.avgActiveDurationMs || 0,
        stats.avgIntermissionMs || 0,
        stats.avgActiveTimeRate || 0,
        stats.avgDamageTakenShare || 0,
        stats.damageTakenShareValidCount || 0,
        stats.totalDeaths || 0,
        stats.totalDeadTimeMs || 0,
        scores.overall || 0,
        scores.mvp || 0,
        (character.buildVariants || [])
          .map((variant) => `${variant.name}:${variant.encounters}:${variant.avgDps}:${variant.avgContextPerformancePercentile || 0}`)
          .join(","),
      ].join(":"));
    }
  }
  for (const encounter of snapshot.encounters || []) {
    const metrics = encounter.metrics || {};
    parts.push([
      "enc",
      encounter.encounterId,
      encounter.characterName,
      encounter.fightStart,
      metrics.dps || 0,
      metrics.rdps || 0,
      metrics.ndps || 0,
      metrics.peak10sDps || 0,
      metrics.burstRatio || 0,
      metrics.rdpsValid ? 1 : 0,
      metrics.activeDurationMs || 0,
      metrics.intermissionMs || 0,
      metrics.activeTimeRate || 0,
      metrics.damageDealt || 0,
      metrics.damageShare || 0,
      metrics.topDamageProximity || 0,
      metrics.contextSampleCount || 0,
      metrics.contextSource || "",
      metrics.contextPerformancePercentile || 0,
      metrics.contextDamageSharePercentile || 0,
      metrics.contextTopDamageProximityPercentile || 0,
      metrics.contextSupportPercentile || 0,
      metrics.damageRank || 0,
      metrics.deathCount || 0,
      metrics.deadTimeMs || 0,
      metrics.counters || 0,
      metrics.critRate || 0,
      metrics.critDamageShare || 0,
      metrics.backAttackDamageShare || 0,
      metrics.frontAttackDamageShare || 0,
      metrics.positionalDamageShare || 0,
      metrics.topSkillShare || 0,
      metrics.protectionPerMinute || 0,
      metrics.damageTakenShare || 0,
      metrics.rdpsDamageGivenPerMinute || 0,
      metrics.supporterDamageGiven || 0,
      metrics.supporterPercent || 0,
      metrics.supporterTier || "",
      metrics.supporterRank || 0,
      metrics.supporterCount || 0,
      (encounter.topSkills || [])
        .slice(0, 5)
        .map((skill) => `${skill.id || skill.name || ""}:${skill.damage || 0}:${skill.share || 0}`)
        .join(","),
    ].join(":"));
  }
  return parts.sort().join("|");
}
