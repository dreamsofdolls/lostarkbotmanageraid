"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RAID_REQUIREMENTS,
  getBaseGoldForGate,
  getBoundGoldForGate,
  getGoldForGate,
  getRaidRequirementMap,
  isGoldBound,
} = require("../bot/domain/raid-catalog");
const {
  toModeKey,
  toModeLabel,
} = require("../bot/utils/raid/common/shared");
const {
  getBestEligibleModeKey,
  normalizeAssignedRaid,
  setAssignedRaidMode,
} = require("../bot/utils/raid/common/character/assigned-raids");
const {
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
  getStatusProgressRaidsForCharacter,
} = require("../bot/utils/raid/common/character");
const { getRaidModeLabel } = require("../bot/utils/raid/common/labels");

const SOLO_RAID_KEYS = ["armoche", "kazeros", "serca"];

test("solo mode is a manual alias of Normal metadata only for difficulty-based raids", () => {
  const requirementMap = getRaidRequirementMap();

  for (const raidKey of SOLO_RAID_KEYS) {
    const raid = RAID_REQUIREMENTS[raidKey];
    assert.equal(raid.supportsSolo, true);
    const normal = raid.modes.normal;
    const solo = raid.modes.solo;
    assert.ok(solo, `${raidKey} should expose Solo mode`);
    assert.equal(solo.baseModeKey, "normal");
    assert.equal(solo.manualOnly, true);
    assert.equal(solo.minItemLevel, normal.minItemLevel);
    assert.deepEqual(solo.gold, normal.gold);
    assert.equal(requirementMap[`${raidKey}_solo`].modeKey, "solo");
  }

  assert.equal(RAID_REQUIREMENTS.horizon.supportsSolo, false);
  assert.equal(RAID_REQUIREMENTS.horizon.modes.solo, undefined);
  assert.equal(requirementMap.horizon_solo, undefined);
});

test("solo mode uses exactly the same base, bound, and unbound gold as Normal", () => {
  for (const raidKey of SOLO_RAID_KEYS) {
    const raid = RAID_REQUIREMENTS[raidKey];
    for (const gate of raid.gates) {
      assert.equal(
        getBaseGoldForGate(raidKey, "solo", gate),
        getBaseGoldForGate(raidKey, "normal", gate),
      );
      assert.equal(
        getGoldForGate(raidKey, "solo", gate),
        getGoldForGate(raidKey, "normal", gate),
      );
      assert.equal(
        getBoundGoldForGate(raidKey, "solo", gate),
        getBoundGoldForGate(raidKey, "normal", gate),
      );
    }
    assert.equal(isGoldBound(raidKey, "solo"), isGoldBound(raidKey, "normal"));
  }
});

test("solo mode has a distinct stored and localized display identity", () => {
  assert.equal(toModeKey("Solo"), "solo");
  assert.equal(toModeKey("Solo Mode"), "solo");
  assert.equal(toModeLabel("solo"), "Solo");
  assert.equal(getRaidModeLabel("armoche", "solo", "en"), "Act 4 Solo");

  const assigned = setAssignedRaidMode({}, "armoche", "solo");
  assert.equal(assigned.modeKey, "solo");
  assert.equal(assigned.G1.difficulty, "Solo");
  assert.equal(assigned.G2.difficulty, "Solo");
  assert.deepEqual(setAssignedRaidMode({}, "horizon", "solo"), {});
});

test("legacy Horizon Solo data normalizes to Level 1 without losing progress", () => {
  const normalized = normalizeAssignedRaid({
    modeKey: "solo",
    goldOverride: "include",
    G1: { difficulty: "Solo", completedDate: 100 },
    G2: { difficulty: "Solo", completedDate: 200 },
  }, "Nightmare", "horizon");

  assert.equal(normalized.modeKey, "normal");
  assert.equal(normalized.goldOverride, "include");
  assert.deepEqual(normalized.G1, { difficulty: "Normal", completedDate: 100 });
  assert.deepEqual(normalized.G2, { difficulty: "Normal", completedDate: 200 });
});

test("automatic eligibility never picks the manual-only Solo mode", () => {
  assert.equal(getBestEligibleModeKey("armoche", 1700), "normal");
  assert.equal(getBestEligibleModeKey("armoche", 1720), "hard");
  assert.equal(getBestEligibleModeKey("horizon", 1750), "nightmare");
});

test("raid-status keeps Solo visible while reusing Normal progress and gold", () => {
  const character = {
    name: "Soloist",
    class: "Artist",
    itemLevel: 1700,
    isGoldEarner: true,
    assignedRaids: {
      armoche: {
        modeKey: "solo",
        G1: { difficulty: "Solo", completedDate: 100 },
        G2: { difficulty: "Solo", completedDate: null },
      },
    },
  };

  const raid = getStatusRaidsForCharacter(character)
    .find((entry) => entry.raidKey === "armoche");
  const countedProgress = getStatusProgressRaidsForCharacter(character);

  assert.equal(raid.modeKey, "solo");
  assert.equal(raid.rawEarnedGold, 12500);
  assert.equal(raid.rawTotalGold, 33000);
  assert.match(formatRaidStatusLine(raid, "en"), /Act 4 Solo/);
  assert.equal(
    countedProgress.some((entry) => entry.raidKey === "armoche"),
    false,
    "Solo remains visible but does not inflate headline raid totals",
  );
});
