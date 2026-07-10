"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeGoldModeOptions,
} = require("../bot/handlers/raid-status/gold/gold-ui/toggle-rows");

test("computeGoldModeOptions offers Solo plus eligible difficulty modes", () => {
  const opts = computeGoldModeOptions("Aurora", [
    {
      raidKey: "armoche",
      modeKey: "normal",
      pendingModeKey: null,
      raidName: "Act 4",
    },
  ], 1720);

  const byMode = Object.fromEntries(opts.map((option) => [option.modeKey, option]));
  assert.deepEqual(Object.keys(byMode).sort(), ["hard", "solo"]);
  assert.equal(byMode.solo.value, "Aurora::armoche::solo");
  assert.equal(byMode.solo.direction, "side");
  assert.equal(byMode.solo.goldTotal, 33000); // same base total as Normal
  assert.equal(byMode.hard.direction, "up");
  assert.equal(byMode.hard.goldTotal, 42000);
  assert.ok(opts.every((option) => option.deferred === false));
});

test("computeGoldModeOptions keeps Solo eligible at the Normal item level", () => {
  const opts = computeGoldModeOptions("Aurora", [
    {
      raidKey: "armoche",
      modeKey: "normal",
      pendingModeKey: null,
      raidName: "Act 4",
    },
  ], 1700);

  assert.deepEqual(opts.map((option) => option.modeKey), ["solo"]);
  assert.equal(opts[0].direction, "side");
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

  const cancel = opts.find((option) => option.modeKey === "normal");
  assert.ok(cancel);
  assert.equal(cancel.isCancel, true);
  assert.equal(cancel.direction, "cancel");
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

test("computeGoldModeOptions treats Solo and Normal as a lateral switch", () => {
  const opts = computeGoldModeOptions("Aurora", [
    {
      raidKey: "armoche",
      modeKey: "solo",
      pendingModeKey: null,
      raidName: "Act 4",
    },
  ], 1700);

  assert.deepEqual(opts.map((option) => option.modeKey), ["normal"]);
  assert.equal(opts[0].direction, "side");
  assert.equal(opts[0].goldTotal, 33000);
});
