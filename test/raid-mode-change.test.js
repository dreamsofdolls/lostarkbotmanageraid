"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hasAssignedRaidModeChange,
  resetAssignedRaidGates,
} = require("../bot/utils/raid/common/character/assigned-raids");

test("raid mode conflicts consider stored mode and official difficulties, including legacy data", () => {
  const cases = [
    [{}, "normal", false],
    [{ modeKey: "normal" }, "normal", false],
    [{ modeKey: "hard" }, "normal", true],
    [{ modeKey: "solo" }, "normal", true],
    [{ G1: { difficulty: "  NORMAL  " } }, "normal", false],
    [{ G1: { difficulty: "Hard", completedDate: null } }, "normal", true],
    [{ G1: { difficulty: "Normal" }, G2: { difficulty: "Hard" } }, "normal", true],
    [{ G1: { difficulty: "" }, G2: null }, "normal", false],
    [{ G9: { difficulty: "Hard" }, pendingModeKey: "hard", goldOverride: "include" }, "normal", false],
  ];
  for (const [raid, mode, expected] of cases) {
    const before = structuredClone(raid);
    assert.equal(hasAssignedRaidModeChange(raid, mode, "Normal", ["G1", "G2"]), expected);
    assert.deepEqual(raid, before, "detecting a conflict must not write to the raid");
  }
  assert.equal(hasAssignedRaidModeChange({ modeKey: "hard" }, "normal", "Normal", []), true);
  assert.equal(hasAssignedRaidModeChange({ G1: { difficulty: "Hard" } }, "normal", "Normal", []), false);
});

test("mode detection uses the injected normalizer and stops after a definite conflict", () => {
  const calls = [];
  const normalize = (value) => {
    calls.push(value);
    return value.toLowerCase().replace("nm", "normal");
  };
  const raid = { modeKey: "normal", G1: { difficulty: "Hard" }, G2: { difficulty: "nm" } };
  assert.equal(hasAssignedRaidModeChange(raid, "normal", "Normal", ["G1", "G2"], normalize), true);
  assert.deepEqual(calls, ["Normal", "Hard"]);
  calls.length = 0;
  assert.equal(hasAssignedRaidModeChange(raid, "solo", "Solo", ["G1", "G2"], normalize), true);
  assert.deepEqual(calls, []);
  assert.equal(hasAssignedRaidModeChange({ G1: { difficulty: "nm" } }, "normal", "Normal", ["G1"], normalize), false);
});

test("gate resets preserve metadata and distinguish undefined progress from an explicit timestamp", () => {
  const raid = {
    modeKey: "hard", pendingModeKey: "solo", goldOverride: "include",
    G1: { difficulty: "Hard", completedDate: 123 },
    G2: { difficulty: "Hard", completedDate: 456 },
    G9: { difficulty: "Legacy", completedDate: 789 },
  };
  resetAssignedRaidGates(raid, ["G1", "G2"], "Normal");
  assert.deepEqual(raid, {
    modeKey: "hard", pendingModeKey: "solo", goldOverride: "include",
    G1: { difficulty: "Normal", completedDate: undefined },
    G2: { difficulty: "Normal", completedDate: undefined },
    G9: { difficulty: "Legacy", completedDate: 789 },
  });
  for (const timestamp of [null, 0, 1000]) {
    resetAssignedRaidGates(raid, ["G1"], "Solo", timestamp);
    assert.deepEqual(raid.G1, { difficulty: "Solo", completedDate: timestamp });
    assert.deepEqual(raid.G2, { difficulty: "Normal", completedDate: undefined });
  }
});
