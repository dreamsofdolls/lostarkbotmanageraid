"use strict";

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDifficultyToModeKey(difficulty) {
  const key = normalizeKey(difficulty);
  if (key === "solo" || key === "solo mode") return "solo";
  if (key === "nightmare" || key === "9m" || key === "level 3" || key === "level3" || key === "l3") return "nightmare";
  if (key === "hard" || key === "hm" || key === "level 2" || key === "level2" || key === "l2") return "hard";
  if (key === "normal" || key === "nor" || key === "nm" || key === "level 1" || key === "level1" || key === "l1") return "normal";
  return null;
}

module.exports = {
  normalizeDifficultyToModeKey,
};
