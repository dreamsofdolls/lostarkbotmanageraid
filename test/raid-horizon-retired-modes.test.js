"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isSelectableMode } = require("../bot/domain/raid-catalog");
const { getStatusRaidsForCharacter } = require("../bot/utils/raid/common/character");
const { applyModeDecision } = require("../bot/handlers/raid-status/gold/gold-actions");
const {
  computeBulkGoldModeOptions,
  computeGoldModeOptions,
} = require("../bot/handlers/raid-status/gold/gold-ui/toggle-rows");

const horizonValues = (options) => options
  .map((option) => option.value)
  .filter((value) => value.startsWith("horizon::"));

function horizonOf(itemLevel, horizon) {
  const character = {
    name: "Aki",
    class: "Bard",
    itemLevel,
    assignedRaids: horizon ? { horizon } : {},
  };
  return getStatusRaidsForCharacter(character).find((raid) => raid.raidKey === "horizon") || null;
}

test("Horizon Level 1 and Level 2 are not selectable; Level 3 and other modes are", () => {
  assert.equal(isSelectableMode("horizon", "normal"), false);
  assert.equal(isSelectableMode("horizon", "hard"), false);
  assert.equal(isSelectableMode("horizon", "nightmare"), true);
  assert.equal(isSelectableMode("armoche", "normal"), true);
  assert.equal(isSelectableMode("armoche", "solo"), true);
  assert.equal(isSelectableMode("horizon", "solo"), false);
});

test("a character below 1750 with no stored Horizon mode shows no Horizon", () => {
  assert.equal(horizonOf(1730), null);
  assert.equal(horizonOf(1710), null);
});

test("a Horizon label left by the old default, with no mode or clears, follows the new default", () => {
  assert.equal(horizonOf(1730, { G1: { difficulty: "Hard" }, G2: { difficulty: "Hard" } }), null);
});

test("a stored Horizon Level 1 still shows and counts its clears", () => {
  const horizon = horizonOf(1730, {
    modeKey: "normal",
    G1: { difficulty: "Normal", completedDate: 100 },
    G2: { difficulty: "Normal" },
  });
  assert.equal(horizon.modeKey, "normal");
  assert.equal(horizon.raidName, "Horizon Level 1");
  assert.deepEqual(horizon.completedGateKeys, ["G1"]);
  assert.equal(horizon.rawEarnedGold, 13500);
});

test("a Level 2 clear without a stored mode still shows as Level 2", () => {
  const horizon = horizonOf(1730, { G1: { difficulty: "Hard", completedDate: 100 } });
  assert.equal(horizon.modeKey, "hard");
  assert.deepEqual(horizon.completedGateKeys, ["G1"]);
});

test("a character at 1750 or above defaults to Horizon Level 3", () => {
  assert.equal(horizonOf(1760).modeKey, "nightmare");
});

test("a sub-1750 Horizon ticked for gold keeps its mode and its gold slot", () => {
  const raids = getStatusRaidsForCharacter({
    name: "Aki",
    class: "Bard",
    itemLevel: 1730,
    assignedRaids: {
      armoche: { goldOverride: "include" },
      kazeros: { goldOverride: "include" },
      serca: { goldOverride: "exclude" },
      horizon: { goldOverride: "include", G1: { difficulty: "Hard" }, G2: { difficulty: "Hard" } },
    },
  });
  assert.equal(raids.find((raid) => raid.raidKey === "horizon")?.modeKey, "hard");
  assert.deepEqual(
    raids.filter((raid) => raid.goldReceives).map((raid) => raid.raidKey),
    ["armoche", "kazeros", "horizon"],
  );
});

test("a sub-1750 Horizon ticked for gold with no stored label shows the mode it was ticked on", () => {
  assert.equal(horizonOf(1730, { goldOverride: "include" })?.modeKey, "hard");
  assert.equal(horizonOf(1710, { goldOverride: "include" })?.modeKey, "normal");
});

test("a sub-1750 Horizon excluded from gold follows the default and stays hidden", () => {
  assert.equal(horizonOf(1730, { goldOverride: "exclude", G1: { difficulty: "Hard" } }), null);
});

test("a gold mode write reads an unset sub-1750 Horizon as unset, like the status card", () => {
  const character = { name: "Aki", class: "Bard", itemLevel: 1730, assignedRaids: {} };
  assert.equal(applyModeDecision(character, "horizon", { modeKey: "normal" }), "immediate");
  assert.equal(character.assignedRaids.horizon.modeKey, "normal");
});

test("the one-character gold mode picker never offers Horizon Level 1 or 2", () => {
  const options = computeGoldModeOptions([
    { raidKey: "horizon", modeKey: "nightmare", pendingModeKey: null },
  ], 1760);
  assert.deepEqual(horizonValues(options), []);
});

test("a queued change away from a stored Level 1 can still be cancelled", () => {
  const options = computeGoldModeOptions([
    { raidKey: "horizon", modeKey: "normal", pendingModeKey: "nightmare", completedGateKeys: ["G1"] },
  ], 1760);
  assert.deepEqual(horizonValues(options), ["horizon::cancel"]);
});

test("the bulk gold mode picker never offers Horizon Level 1 or 2", () => {
  const options = computeBulkGoldModeOptions([
    { itemLevel: 1760, raids: [{ raidKey: "horizon", modeKey: "nightmare" }] },
    { itemLevel: 1730, raids: [{ raidKey: "horizon", modeKey: "hard" }] },
  ]);
  assert.deepEqual(horizonValues(options), []);
});
