"use strict";

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

const MODE_KEY_BY_DIFFICULTY = new Map(
  Object.entries({
    solo: ["solo", "solo mode"],
    nightmare: ["nightmare", "9m", "level 3", "level3", "l3"],
    hard: ["hard", "hm", "level 2", "level2", "l2"],
    normal: ["normal", "nor", "nm", "level 1", "level1", "l1"],
  }).flatMap(([modeKey, aliases]) => (
    aliases.map((alias) => [alias, modeKey])
  ))
);

function normalizeDifficultyToModeKey(difficulty) {
  return MODE_KEY_BY_DIFFICULTY.get(normalizeKey(difficulty)) || null;
}

module.exports = {
  normalizeDifficultyToModeKey,
};
