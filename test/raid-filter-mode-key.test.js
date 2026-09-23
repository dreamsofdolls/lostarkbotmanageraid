"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const character = require("../bot/utils/raid/common/character");
const raidFilter = require("../bot/handlers/raid-status/raid-filter");

test("the /raid-status counting rule lives in the shared character helpers", () => {
  assert.equal(typeof character.isCountedRaidFilterProgress, "function");
  assert.equal(raidFilter.isCountedRaidFilterProgress, character.isCountedRaidFilterProgress);
});

test("solo raids stay out of the counted totals", () => {
  assert.equal(character.isCountedRaidFilterProgress({ raidKey: "kazeros", modeKey: "solo" }), false);
});
