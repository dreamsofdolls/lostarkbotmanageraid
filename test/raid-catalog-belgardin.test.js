"use strict";

// Belgardin: two gates, 8 players, Normal 1750 / Hard 1770 / Nightmare 1780.
// These tests pin its catalog entry and what it does to a 1750+ character's
// three gold slots.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RAID_ORDER,
  getBaseGoldForGate,
  getBoundGoldForGate,
  getGatesForRaid,
  getGoldForGate,
  getRaidLabel,
  getRaidPartySize,
  getRaidRequirementMap,
} = require("../bot/domain/raid-catalog");
const { getStatusRaidsForCharacter } = require("../bot/utils/raid/common/character");
const { parseRaidMessage } = require("../bot/services/raid/channel-monitor/channel-monitor-parser");

function baseGoldTotal(modeKey) {
  return getGatesForRaid("belgardin")
    .reduce((sum, gate) => sum + getBaseGoldForGate("belgardin", modeKey, gate), 0);
}

function boundGoldTotal(modeKey) {
  return getGatesForRaid("belgardin")
    .reduce((sum, gate) => sum + getBoundGoldForGate("belgardin", modeKey, gate), 0);
}

test("Belgardin is the newest raid: 8 players, two gates, Normal 1750 / Hard 1770 / Nightmare 1780", () => {
  assert.equal(RAID_ORDER.at(-1), "belgardin");
  assert.equal(getRaidLabel("belgardin"), "Belgardin");
  assert.equal(getRaidPartySize("belgardin"), 8);
  assert.deepEqual(getGatesForRaid("belgardin"), ["G1", "G2"]);

  const requirementMap = getRaidRequirementMap();
  assert.deepEqual(
    ["normal", "hard", "nightmare"].map((modeKey) => {
      const { label, minItemLevel } = requirementMap[`belgardin_${modeKey}`];
      return [label, minItemLevel];
    }),
    [["Belgardin Normal", 1750], ["Belgardin Hard", 1770], ["Belgardin Nightmare", 1780]],
  );
});

test("Belgardin Normal pays 20,000 + 30,000 with half of each gate bound", () => {
  assert.deepEqual(
    ["G1", "G2"].map((gate) => [
      getBaseGoldForGate("belgardin", "normal", gate),
      getGoldForGate("belgardin", "normal", gate),
      getBoundGoldForGate("belgardin", "normal", gate),
    ]),
    [[20000, 10000, 10000], [30000, 15000, 15000]],
  );
});

test("Belgardin Hard and Nightmare pay their published totals as tradeable gold", () => {
  assert.equal(baseGoldTotal("hard"), 62000);
  assert.equal(baseGoldTotal("nightmare"), 75000);
  assert.equal(boundGoldTotal("hard"), 0);
  assert.equal(boundGoldTotal("nightmare"), 0);
});

test("a 1750 character has five raids and exactly two that earn no gold", () => {
  const raids = getStatusRaidsForCharacter({ itemLevel: 1750, assignedRaids: {}, tasks: [] });
  assert.deepEqual(raids.map((raid) => raid.raidKey), RAID_ORDER);

  const locked = raids.filter((raid) => !raid.goldReceives);
  assert.equal(locked.length, 2);
  assert.deepEqual(
    locked.map((raid) => raid.goldExcludedReason).sort(),
    ["bound", "cap"],
  );
  assert.equal(locked.find((raid) => raid.goldExcludedReason === "bound").raidKey, "horizon");
});

function goldSlots(raids) {
  return raids.map((raid) => [raid.raidKey, raid.goldSlotRank, raid.goldExcludedReason]);
}

test("a 1750 character with nothing cleared keeps its gold slots on the three highest-paying raids", () => {
  // Serca Nightmare 54,000 > Belgardin Normal 50,000 > Kazeros Hard 48,000 >
  // Act 4 Hard 38,000, so Act 4 is the raid left outside the cap.
  const raids = getStatusRaidsForCharacter({ itemLevel: 1750, assignedRaids: {}, tasks: [] });
  assert.deepEqual(goldSlots(raids), [
    ["armoche", null, "cap"],
    ["kazeros", 3, null],
    ["serca", 1, null],
    ["horizon", null, "bound"],
    ["belgardin", 2, null],
  ]);
});

test("a cleared raid keeps its gold slot ahead of higher-paying raids not cleared yet", () => {
  const raids = getStatusRaidsForCharacter({
    itemLevel: 1750,
    assignedRaids: {
      armoche: {
        modeKey: "hard",
        G1: { difficulty: "Hard", completedDate: 100 },
        G2: { difficulty: "Hard", completedDate: 200 },
      },
    },
    tasks: [],
  });
  assert.deepEqual(goldSlots(raids), [
    ["armoche", 1, null],
    ["kazeros", null, "cap"],
    ["serca", 2, null],
    ["horizon", null, "bound"],
    ["belgardin", 3, null],
  ]);
});

test("a 1749 character is not offered Belgardin", () => {
  const raids = getStatusRaidsForCharacter({ itemLevel: 1749, assignedRaids: {}, tasks: [] });
  assert.equal(raids.some((raid) => raid.raidKey === "belgardin"), false);
});

test("the raid channel accepts belgardin and belg", () => {
  const expected = { raidKey: "belgardin", modeKey: "hard", charNames: ["qiylyn"], gate: "G1" };
  assert.deepEqual(parseRaidMessage("Belgardin HM Qiylyn G1"), expected);
  assert.deepEqual(parseRaidMessage("belg hm Qiylyn G1"), expected);
});
