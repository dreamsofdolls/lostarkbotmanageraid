"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clearCharacterProgress,
} = require("../bot/services/raid/schedulers/weekly-reset");

function charWith(assignedRaids, itemLevel = 1720) {
  return { itemLevel, assignedRaids, tasks: [] };
}

test("weekly reset applies a queued pending mode and clears the field", () => {
  const char = charWith({
    armoche: {
      modeKey: "normal",
      pendingModeKey: "hard",
      G1: { difficulty: "Normal", completedDate: 10 },
      G2: { difficulty: "Normal", completedDate: 10 },
    },
  });

  clearCharacterProgress(char, { preserveSinceMs: null });

  const raid = char.assignedRaids.armoche;
  assert.equal(raid.modeKey, "hard");
  assert.equal(raid.pendingModeKey, undefined);
  assert.equal(raid.G1.difficulty, "Hard");
  assert.equal(raid.G1.completedDate, null);
  assert.equal(raid.G2.difficulty, "Hard");
  assert.equal(raid.G2.completedDate, null);
});

test("weekly reset drops a pending mode the character no longer qualifies for", () => {
  const char = charWith({
    armoche: {
      modeKey: "normal",
      pendingModeKey: "hard",
      G1: {},
      G2: {},
    },
  }, 1700);

  clearCharacterProgress(char, { preserveSinceMs: null });

  const raid = char.assignedRaids.armoche;
  assert.equal(raid.modeKey, "normal");
  assert.equal(raid.pendingModeKey, undefined);
});

test("weekly reset does not relabel a preserved current-week clear into pending mode", () => {
  const char = charWith({
    armoche: {
      modeKey: "normal",
      pendingModeKey: "hard",
      G1: { difficulty: "Normal", completedDate: 5000 },
      G2: { difficulty: "Normal", completedDate: 5000 },
    },
  });

  clearCharacterProgress(char, { preserveSinceMs: 1000 });

  const raid = char.assignedRaids.armoche;
  assert.equal(raid.modeKey, "normal");
  assert.equal(raid.G1.difficulty, "Normal");
  assert.equal(raid.G1.completedDate, 5000);
  assert.equal(raid.pendingModeKey, undefined);
});
