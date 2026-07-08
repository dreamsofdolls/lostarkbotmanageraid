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
  assert.equal(opts[0].direction, "up");
  assert.equal(opts[0].deferred, false); // no completed gates -> applies now
  assert.equal(opts[0].currentModeKey, "normal");
  assert.equal(opts[0].goldTotal, 42000); // Act 4 Hard: 15000 + 27000
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
  assert.equal(opts[0].direction, "cancel");
});

test("computeGoldModeOptions tags direction + defers when the raid ran this week", () => {
  const opts = computeGoldModeOptions("Aurora", [
    {
      raidKey: "serca",
      modeKey: "hard",
      pendingModeKey: null,
      completedGateKeys: ["G1"],
      raidName: "Serca",
    },
  ], 1740);

  // Serca modes: normal(1710) < hard(1730) < nightmare(1740). From current
  // Hard, Normal is a downgrade and Nightmare an upgrade; both defer because
  // a gate already cleared this week.
  const byMode = Object.fromEntries(opts.map((option) => [option.modeKey, option]));
  assert.equal(byMode.normal.direction, "down");
  assert.equal(byMode.nightmare.direction, "up");
  assert.equal(byMode.normal.deferred, true);
  assert.equal(byMode.nightmare.deferred, true);
});
