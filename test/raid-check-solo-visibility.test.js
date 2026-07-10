"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  filterRaidCheckRequirementMap,
  isRaidCheckVisibleMode,
  isRaidCheckVisibleRaid,
} = require("../bot/handlers/raid-check/visibility");

test("raid-check visibility rejects Solo but keeps group modes", () => {
  assert.equal(isRaidCheckVisibleMode("solo"), false);
  assert.equal(isRaidCheckVisibleMode("Solo"), false);
  assert.equal(isRaidCheckVisibleMode("normal"), true);
  assert.equal(isRaidCheckVisibleMode("hard"), true);
  assert.equal(isRaidCheckVisibleRaid({ modeKey: "solo" }), false);
  assert.equal(isRaidCheckVisibleRaid({ modeKey: "normal" }), true);
});

test("raid-check requirement map removes Solo entries without mutating the source", () => {
  const source = {
    armoche_normal: { raidKey: "armoche", modeKey: "normal" },
    armoche_solo: { raidKey: "armoche", modeKey: "solo" },
    armoche_hard: { raidKey: "armoche", modeKey: "hard" },
  };

  const filtered = filterRaidCheckRequirementMap(source);

  assert.deepEqual(Object.keys(filtered), ["armoche_normal", "armoche_hard"]);
  assert.ok(source.armoche_solo, "source catalog must stay intact for raid-status");
});
