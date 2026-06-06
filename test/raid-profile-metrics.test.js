const test = require("node:test");
const assert = require("node:assert/strict");

test("raid-profile DPS consistency uses normalized output signals over raw boss DPS", async () => {
  const { computeProfileConsistency } = await import("../web/js/profile/metrics/profile-metrics.js");

  const score = computeProfileConsistency([
    { dps: 12000000, damageShare: 24.0, topDamageProximity: 88.0 },
    { dps: 26000000, damageShare: 25.5, topDamageProximity: 91.0 },
    { dps: 47000000, damageShare: 23.5, topDamageProximity: 87.5 },
    { dps: 65000000, damageShare: 24.8, topDamageProximity: 90.2 },
  ], "dps");

  assert.ok(score > 85, `expected normalized consistency to stay high, got ${score}`);
});

test("raid-profile support consistency ignores noisy raw DPS when support output is stable", async () => {
  const { computeProfileConsistency } = await import("../web/js/profile/metrics/profile-metrics.js");

  const score = computeProfileConsistency([
    { dps: 100000, rdpsValid: true, supporterPercent: 30.0, protectionPerMinute: 8800000, supportAp: 0.9, supportBrand: 0.88, supportIdentity: 0.42, supportHyper: 0.18 },
    { dps: 900000, rdpsValid: true, supporterPercent: 31.0, protectionPerMinute: 9100000, supportAp: 0.91, supportBrand: 0.87, supportIdentity: 0.43, supportHyper: 0.2 },
    { dps: 4500000, rdpsValid: true, supporterPercent: 29.5, protectionPerMinute: 8600000, supportAp: 0.89, supportBrand: 0.9, supportIdentity: 0.41, supportHyper: 0.17 },
    { dps: 200000, rdpsValid: true, supporterPercent: 30.5, protectionPerMinute: 9000000, supportAp: 0.92, supportBrand: 0.88, supportIdentity: 0.44, supportHyper: 0.19 },
  ], "support");

  assert.ok(score > 90, `expected stable support output to score high, got ${score}`);
});

test("raid-profile consistency drops when normalized output is volatile", async () => {
  const { computeProfileConsistency } = await import("../web/js/profile/metrics/profile-metrics.js");

  const score = computeProfileConsistency([
    { dps: 25000000, damageShare: 30.0, topDamageProximity: 100.0 },
    { dps: 24000000, damageShare: 8.0, topDamageProximity: 25.0 },
    { dps: 26000000, damageShare: 26.0, topDamageProximity: 82.0 },
    { dps: 25500000, damageShare: 6.0, topDamageProximity: 20.0 },
  ], "dps");

  assert.ok(score < 70, `expected volatile normalized output to score lower, got ${score}`);
});
