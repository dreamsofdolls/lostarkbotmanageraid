"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeGoldModeOptions,
} = require("../bot/handlers/raid-status/gold/gold-ui/toggle-rows");

test("computeGoldModeOptions offers eligible alternative modes and excludes the current target", () => {
  const opts = computeGoldModeOptions("Aurora", [
    {
      raidKey: "armoche",
      modeKey: "normal",
      pendingModeKey: null,
      raidName: "Act 4",
    },
  ], 1720);

  assert.equal(opts.length, 1);
  assert.equal(opts[0].modeKey, "hard");
  assert.equal(opts[0].value, "Aurora::armoche::hard");
  assert.equal(opts[0].isCancel, false);
});

test("computeGoldModeOptions filters out modes above item level", () => {
  const opts = computeGoldModeOptions("Aurora", [
    {
      raidKey: "armoche",
      modeKey: "normal",
      pendingModeKey: null,
      raidName: "Act 4",
    },
  ], 1700);

  assert.equal(opts.length, 0);
});

test("computeGoldModeOptions includes the current mode as a cancel option when pending is set", () => {
  const opts = computeGoldModeOptions("Aurora", [
    {
      raidKey: "armoche",
      modeKey: "normal",
      pendingModeKey: "hard",
      raidName: "Act 4",
    },
  ], 1720);

  assert.equal(opts.length, 1);
  assert.equal(opts[0].modeKey, "normal");
  assert.equal(opts[0].isCancel, true);
});
