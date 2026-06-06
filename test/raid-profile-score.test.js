const test = require("node:test");
const assert = require("node:assert/strict");

test("raid-profile score module computes bounded DPS and support score sets", async () => {
  const { computeProfileScores, MIN_CONTEXT_SAMPLE_COUNT } = await import("../web/js/profile/metrics/profile-score.js");

  assert.equal(MIN_CONTEXT_SAMPLE_COUNT, 10);

  const dps = computeProfileScores({
    partyCountAvg: 4,
    avgDamageShare: 28,
    avgRank: 1.8,
    avgTopDamageProximity: 85,
    topRate: 25,
    contextCoverageRate: 80,
    contextSampleCountAvg: 14,
    avgContextPerformancePercentile: 72,
    consistency: 88,
    deathlessRate: 90,
    deathRate: 10,
    avgDeaths: 0.1,
    avgDeadTimeRate: 2,
    avgCounters: 1,
    avgStaggerPerMinute: 2800,
    avgIncapacitationsPerMinute: 0,
  }, "dps");

  assert.ok(dps.overall > 0 && dps.overall <= 100);
  assert.ok(dps.mvp > 0 && dps.mvp <= 100);
  assert.equal(typeof dps.output, "number");

  const support = computeProfileScores({
    partyCountAvg: 8,
    avgDamageShare: 3,
    avgRank: 7,
    avgTopDamageProximity: 20,
    contextCoverageRate: 90,
    contextSampleCountAvg: 16,
    avgContextSupportPercentile: 78,
    consistency: 92,
    deathlessRate: 95,
    deathRate: 5,
    avgDeaths: 0.1,
    avgDeadTimeRate: 1,
    avgCounters: 0.5,
    avgStaggerPerMinute: 1800,
    avgIncapacitationsPerMinute: 0,
    avgSupportAp: 0.9,
    avgSupportBrand: 0.88,
    avgSupportIdentity: 0.45,
    avgSupportHyper: 0.2,
    avgRdpsDamageGivenPerMinute: 40000000000,
    avgSupporterPercent: 30,
    supporterCountAvg: 2,
    avgSupporterRank: 1.2,
    supporterCompetitiveCount: 8,
    supporterTopRate: 70,
    rdpsValidRate: 90,
    avgProtectionPerMinute: 8000000,
  }, "support");

  assert.ok(support.overall > 0 && support.overall <= 100);
  assert.ok(support.raidContribution > 0 && support.raidContribution <= 100);
  assert.equal(typeof support.supportRank, "number");
});
