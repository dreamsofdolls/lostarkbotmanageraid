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
  setAssignedRaidMode,
} = require("../bot/utils/raid/common/character/assigned-raids");
const {
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
} = require("../bot/utils/raid/common/character");
const { getRaidModeLabel } = require("../bot/utils/raid/common/labels");

test("solo mode is a manual alias of Normal metadata for every raid", () => {
  const requirementMap = getRaidRequirementMap();

  for (const [raidKey, raid] of Object.entries(RAID_REQUIREMENTS)) {
    const normal = raid.modes.normal;
    const solo = raid.modes.solo;
    assert.ok(solo, `${raidKey} should expose Solo mode`);
    assert.equal(solo.baseModeKey, "normal");
    assert.equal(solo.manualOnly, true);
    assert.equal(solo.minItemLevel, normal.minItemLevel);
    assert.deepEqual(solo.gold, normal.gold);
    assert.equal(requirementMap[`${raidKey}_solo`].modeKey, "solo");
  }
});

test("solo mode uses exactly the same base, bound, and unbound gold as Normal", () => {
  for (const [raidKey, raid] of Object.entries(RAID_REQUIREMENTS)) {
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
  assert.equal(getRaidModeLabel("horizon", "solo", "vi"), "Horizon Solo");

  const assigned = setAssignedRaidMode({}, "armoche", "solo");
  assert.equal(assigned.modeKey, "solo");
  assert.equal(assigned.G1.difficulty, "Solo");
  assert.equal(assigned.G2.difficulty, "Solo");
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

  assert.equal(raid.modeKey, "solo");
  assert.equal(raid.rawEarnedGold, 12500);
  assert.equal(raid.rawTotalGold, 33000);
  assert.match(formatRaidStatusLine(raid, "en"), /Act 4 Solo/);
});
