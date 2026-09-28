"use strict";

const {
  CORE_MODE_ALIASES,
  SHORTHAND_MODE_ALIASES,
  buildModeAliasMap,
} = require("../../../domain/difficulty-aliases");

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

const MODE_KEY_BY_DIFFICULTY = buildModeAliasMap(CORE_MODE_ALIASES, SHORTHAND_MODE_ALIASES);

function normalizeDifficultyToModeKey(difficulty) {
  return MODE_KEY_BY_DIFFICULTY.get(normalizeKey(difficulty)) || null;
}

module.exports = {
  normalizeDifficultyToModeKey,
};
