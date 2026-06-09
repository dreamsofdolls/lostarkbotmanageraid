"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  __test: summaryBuilderTest,
} = require("../bot/services/local-sync/profile/summary-snapshot-builder");

test("local sync summary builder uses browser profile scoring modules", async () => {
  const backendScoring = await summaryBuilderTest.loadProfileScoringModules();
  const webScore = await import("../web/js/profile/metrics/profile-score.js");
  const webMetrics = await import("../web/js/profile/metrics/profile-metrics.js");

  assert.equal(backendScoring.MIN_CONTEXT_SAMPLE_COUNT, webScore.MIN_CONTEXT_SAMPLE_COUNT);

  const dpsStats = {
    partyCountAvg: 4,
    avgDamageShare: 32.5,
    avgRank: 1.8,
    avgTopDamageProximity: 83,
    topRate: 45,
    contextCoverageRate: 100,
    contextSampleCountAvg: 12,
    avgContextPerformancePercentile: 71,
    consistency: 88,
    deathlessRate: 90,
    deathRate: 10,
    avgDeaths: 0.2,
    avgDeadTimeRate: 2,
    damageTakenShareValidCount: 4,
    avgDamageTakenShare: 19,
    avgCounters: 1.4,
    avgStaggerPerMinute: 2100,
    avgIncapacitationsPerMinute: 0.1,
  };

  const supportStats = {
    ...dpsStats,
    avgRdpsDamageGivenPerMinute: 35000000000,
    avgSupporterPercent: 24,
    avgSupporterRank: 1.2,
    supporterCountAvg: 2,
    supporterCompetitiveCount: 4,
    supporterTopRate: 50,
    avgContextSupportPercentile: 67,
    rdpsValidRate: 80,
    avgProtectionPerMinute: 8000000,
    avgSupportAp: 0.88,
    avgSupportBrand: 0.85,
    avgSupportIdentity: 0.5,
    avgSupportHyper: 0.2,
  };

  assert.deepEqual(
    backendScoring.computeScores(dpsStats, "dps"),
    webScore.computeProfileScores(dpsStats, "dps")
  );
  assert.deepEqual(
    backendScoring.computeScores(supportStats, "support"),
    webScore.computeProfileScores(supportStats, "support")
  );

  const rows = [
    {
      dps: 100,
      damageShare: 28,
      topDamageProximity: 91,
      rdpsValid: true,
      supporterPercent: 24,
      protectionPerMinute: 7100000,
      supportAp: 0.8,
      supportBrand: 0.82,
      supportIdentity: 0.45,
      supportHyper: 0.2,
    },
    {
      dps: 110,
      damageShare: 31,
      topDamageProximity: 95,
      rdpsValid: true,
      supporterPercent: 27,
      protectionPerMinute: 7700000,
      supportAp: 0.83,
      supportBrand: 0.86,
      supportIdentity: 0.48,
      supportHyper: 0.23,
    },
    {
      dps: 97,
      damageShare: 29,
      topDamageProximity: 88,
      rdpsValid: true,
      supporterPercent: 22,
      protectionPerMinute: 6900000,
      supportAp: 0.78,
      supportBrand: 0.81,
      supportIdentity: 0.43,
      supportHyper: 0.18,
    },
  ];

  assert.equal(
    backendScoring.computeProfileConsistency(rows, "dps"),
    webMetrics.computeProfileConsistency(rows, "dps")
  );
  assert.equal(
    backendScoring.computeProfileConsistency(rows, "support"),
    webMetrics.computeProfileConsistency(rows, "support")
  );
});
