"use strict";

export const MIN_CONTEXT_SAMPLE_COUNT = 10;

const SUPPORT_PROTECTION_P90_PER_MIN = 10000000;
const SUPPORT_RDPS_GIVEN_P90_PER_MIN = 50000000000;
const STAGGER_P90_PER_MIN = 3500;

function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function normalizeRate(value) {
  const n = Number(value) || 0;
  if (n > 1 && n <= 100) return n / 100;
  return Math.max(0, Math.min(1, n));
}

function supportUptimeScoreFromStats(stats) {
  const supportAp = normalizeRate(stats.avgSupportAp);
  const supportBrand = normalizeRate(stats.avgSupportBrand);
  const supportIdentity = normalizeRate(stats.avgSupportIdentity);
  const supportHyper = normalizeRate(stats.avgSupportHyper);
  return clampScore(
    (supportAp * 0.3 +
      supportBrand * 0.3 +
      supportIdentity * 0.25 +
      supportHyper * 0.15) * 100
  );
}

function computeSurvivalScore(stats) {
  const deathlessRate = Number(stats.deathlessRate);
  const derivedDeathRate = Number.isFinite(deathlessRate) ? 100 - deathlessRate : 0;
  const deathRate = Number.isFinite(Number(stats.deathRate)) ? Number(stats.deathRate) : derivedDeathRate;
  const avgDeaths = Number(stats.avgDeaths) || 0;
  const deadTimeRate = Number(stats.avgDeadTimeRate) || 0;
  const baseScore = clampScore(100 - deathRate * 1.1 - avgDeaths * 15 - deadTimeRate * 0.5);
  const damageTakenShare = Number(stats.avgDamageTakenShare) || 0;
  const validDamageTakenShares = Number(stats.damageTakenShareValidCount) || 0;
  if (!validDamageTakenShares || damageTakenShare <= 0) return baseScore;

  const partyCount = Math.max(1, Number(stats.partyCountAvg) || 8);
  const expectedShare = 100 / partyCount;
  const graceShare = expectedShare * 1.15;
  const highPressureShare = expectedShare * 2.8;
  const pressureScore = damageTakenShare <= graceShare
    ? 100
    : clampScore(100 - ((damageTakenShare - graceShare) / Math.max(1, highPressureShare - graceShare)) * 100);
  return clampScore(baseScore * 0.75 + pressureScore * 0.25);
}

function computeMechanicsScore(stats) {
  const counterScore = stats.avgCounters > 0 ? clampScore(stats.avgCounters * 25) : 50;
  const staggerScore = stats.avgStaggerPerMinute > 0
    ? clampScore((stats.avgStaggerPerMinute / STAGGER_P90_PER_MIN) * 100)
    : 50;
  const controlScore = clampScore(100 - (Number(stats.avgIncapacitationsPerMinute) || 0) * 40);
  return clampScore(counterScore * 0.35 + staggerScore * 0.35 + controlScore * 0.3);
}

export function computeProfileScores(stats, role) {
  const expectedShare = stats.partyCountAvg > 0 ? 100 / stats.partyCountAvg : 20;
  const damageShareScore = clampScore((stats.avgDamageShare / Math.max(1, expectedShare)) * 70);
  const rankScore = stats.partyCountAvg > 1
    ? clampScore(100 - ((stats.avgRank - 1) / (stats.partyCountAvg - 1)) * 100)
    : 50;
  const outputScore = clampScore(damageShareScore * 0.65 + rankScore * 0.35);
  const topDamageProximityScore = stats.avgTopDamageProximity > 0
    ? clampScore(stats.avgTopDamageProximity)
    : (stats.topRate || 0);
  const hasContextScore = (Number(stats.contextCoverageRate) || 0) > 0 &&
    (Number(stats.contextSampleCountAvg) || 0) >= MIN_CONTEXT_SAMPLE_COUNT;
  const contextScore = hasContextScore ? clampScore(Number(stats.avgContextPerformancePercentile) || 0) : null;
  const contextualOutputScore = contextScore === null
    ? outputScore
    : clampScore(outputScore * 0.75 + contextScore * 0.25);
  const consistencyScore = clampScore(stats.consistency);
  const survivalScore = computeSurvivalScore(stats);
  const mechanicsScore = computeMechanicsScore(stats);

  if (role === "support") {
    const legacyUptimeScore = supportUptimeScoreFromStats(stats);
    const rdpsImpactScore = stats.avgRdpsDamageGivenPerMinute > 0
      ? clampScore((stats.avgRdpsDamageGivenPerMinute / SUPPORT_RDPS_GIVEN_P90_PER_MIN) * 100)
      : 0;
    const supporterPercentScore = stats.avgSupporterPercent > 0
      ? clampScore((stats.avgSupporterPercent / 35) * 100)
      : 0;
    const baseImpactScore = supporterPercentScore > 0
      ? supporterPercentScore
      : rdpsImpactScore > 0 ? rdpsImpactScore : legacyUptimeScore;
    const rankPositionScore = stats.supporterCountAvg > 1 && stats.avgSupporterRank > 0
      ? clampScore(100 - ((stats.avgSupporterRank - 1) / (stats.supporterCountAvg - 1)) * 100)
      : 0;
    const supportRankScore = stats.supporterCompetitiveCount > 0
      ? clampScore(rankPositionScore * 0.6 + (stats.supporterTopRate || 0) * 0.4)
      : 0;
    const impactScore = supportRankScore > 0
      ? clampScore(baseImpactScore * 0.85 + supportRankScore * 0.15)
      : baseImpactScore;
    const supportContextScore = hasContextScore
      ? clampScore(Number(stats.avgContextSupportPercentile) || Number(stats.avgContextPerformancePercentile) || 0)
      : null;
    const contextualImpactScore = supportContextScore === null
      ? impactScore
      : clampScore(impactScore * 0.85 + supportContextScore * 0.15);
    const rdpsCoverage = clampScore(Number(stats.rdpsValidRate) || 0) / 100;
    const confidenceScale = rdpsImpactScore > 0 ? 0.6 + rdpsCoverage * 0.4 : 0.6;
    const raidContribution = clampScore(contextualImpactScore * confidenceScale);
    const protectionScore = stats.avgProtectionPerMinute > 0
      ? clampScore((stats.avgProtectionPerMinute / SUPPORT_PROTECTION_P90_PER_MIN) * 100)
      : 50;
    const overall = clampScore(
      raidContribution * 0.35 +
      contextualImpactScore * 0.15 +
      protectionScore * 0.2 +
      consistencyScore * 0.1 +
      mechanicsScore * 0.1 +
      survivalScore * 0.1
    );
    const mvp = clampScore(
      raidContribution * 0.4 +
      contextualImpactScore * 0.15 +
      protectionScore * 0.2 +
      mechanicsScore * 0.1 +
      consistencyScore * 0.1 +
      survivalScore * 0.05
    );
    return {
      overall: round1(overall),
      mvp: round1(mvp),
      raidContribution: round1(raidContribution),
      supportUptime: round1(contextualImpactScore),
      supportRank: round1(supportRankScore),
      context: round1(supportContextScore ?? 0),
      protection: round1(protectionScore),
      consistency: round1(consistencyScore),
      survival: round1(survivalScore),
      mechanics: round1(mechanicsScore),
    };
  }

  const mvp = clampScore(
    damageShareScore * 0.3 +
    (stats.topRate || 0) * 0.2 +
    topDamageProximityScore * 0.15 +
    contextualOutputScore * 0.15 +
    consistencyScore * 0.1 +
    survivalScore * 0.07 +
    mechanicsScore * 0.03
  );
  const overall = clampScore(
    contextualOutputScore * 0.33 +
    damageShareScore * 0.18 +
    (rankScore * 0.6 + (stats.topRate || 0) * 0.4) * 0.14 +
    topDamageProximityScore * 0.08 +
    consistencyScore * 0.14 +
    survivalScore * 0.09 +
    mechanicsScore * 0.04
  );
  return {
    overall: round1(overall),
    mvp: round1(mvp),
    output: round1(contextualOutputScore),
    damageShare: round1(damageShareScore),
    rank: round1(rankScore),
    context: round1(contextScore ?? 0),
    consistency: round1(consistencyScore),
    survival: round1(survivalScore),
    mechanics: round1(mechanicsScore),
  };
}

export const __test = {
  computeMechanicsScore,
  computeSurvivalScore,
  supportUptimeScoreFromStats,
};
