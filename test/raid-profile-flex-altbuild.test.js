const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSnapshotFromRows,
} = require("../bot/services/auto-manage/profile-builder/stats/snapshot");

// Minimal bible profile row. buildSnapshotFromRows reads row.role directly for
// the support/dps build split (role classification happens upstream in
// logToProfileRow), so the tests drive the split by setting role per row.
function bibleRow(overrides = {}) {
  return {
    accountName: "Clauseduk",
    localPlayer: "Notmeow",
    className: "Artist",
    classRole: "support",
    role: "dps",
    itemLevel: 1680,
    fightStart: 1000,
    durationMs: 600000,
    boss: "Aegir",
    raidKey: "aegir",
    modeKey: "normal",
    difficulty: "Normal",
    dps: 10000000,
    udps: 0,
    rdps: 0,
    ndps: 0,
    biblePercentile: 50,
    overallBiblePercentile: 50,
    deathCount: 0,
    isDead: false,
    isBus: false,
    supportAp: 0,
    supportBrand: 0,
    supportIdentity: 0,
    supportHyper: 0,
    hasSupportBuffs: false,
    build: { spec: "judgment", gearScore: 1680, combatPower: 0 },
    ...overrides,
  };
}

test("bible scorer computes altBuild for a flex char above the log threshold", () => {
  const rows = [
    // 4 DPS-build logs -> become the ALT build (support is always primary here)
    ...Array.from({ length: 4 }, (_, i) =>
      bibleRow({ fightStart: 2000 + i, role: "dps" })),
    // 3 support-build logs (>= threshold) -> PRIMARY (support class scored on support)
    ...Array.from({ length: 3 }, (_, i) =>
      bibleRow({
        fightStart: 1000 + i,
        role: "support",
        hasSupportBuffs: true,
        supportAp: 0.5,
        build: { spec: "blessedaura", gearScore: 1680, combatPower: 0 },
      })),
  ];

  const { snapshot } = buildSnapshotFromRows({ rows, rangeType: "full" });
  const char = snapshot.accounts[0].characters[0];

  assert.equal(char.role, "support", "support class is scored on its support build, not the majority build");
  assert.ok(char.altBuild, "flex char should carry an altBuild");
  assert.equal(char.altBuild.role, "dps");
  assert.equal(char.altBuild.encounters, 4);
  assert.ok(Number.isFinite(char.altBuild.scores.overall));
  assert.equal(char.altBuild.stats.encounters, 4, "altBuild carries its own full stats for the alt table");
  // Primary scoring reflects only the support-build logs.
  assert.equal(char.stats.encounters, 3);
  assert.equal(char.stats.supportLogCount, 3);
});

test("bible scorer omits altBuild when the off-meta DPS build is below the threshold", () => {
  const rows = [
    // 5 support logs -> support is primary
    ...Array.from({ length: 5 }, (_, i) =>
      bibleRow({
        fightStart: 2000 + i,
        role: "support",
        hasSupportBuffs: true,
        build: { spec: "blessedaura", gearScore: 1680, combatPower: 0 },
      })),
    // only 2 DPS-build logs (< 3) -> no alt
    ...Array.from({ length: 2 }, (_, i) =>
      bibleRow({ fightStart: 1000 + i, role: "dps" })),
  ];

  const { snapshot } = buildSnapshotFromRows({ rows, rangeType: "full" });
  const char = snapshot.accounts[0].characters[0];

  assert.equal(char.role, "support");
  assert.equal(char.stats.encounters, 5);
  assert.equal(char.altBuild, null);
});

test("bible scorer leaves a pure DPS class with no altBuild", () => {
  const rows = Array.from({ length: 6 }, (_, i) =>
    bibleRow({
      localPlayer: "Qiylyn",
      className: "Aeromancer",
      classRole: "dps",
      role: "dps",
      fightStart: 1000 + i,
      build: { spec: "wind-fury", gearScore: 1680, combatPower: 0 },
    }));

  const { snapshot } = buildSnapshotFromRows({ rows, rangeType: "full" });
  const char = snapshot.accounts[0].characters[0];

  assert.equal(char.role, "dps");
  assert.equal(char.altBuild, null);
});
