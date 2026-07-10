"use strict";

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function booleanFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const key = normalizeKey(value);
  if (!key || key === "false" || key === "0" || key === "no" || key === "n") return false;
  if (key === "true" || key === "1" || key === "yes" || key === "y") return true;
  return Boolean(value);
}

function durationToMs(value) {
  if (typeof value === "string") {
    const text = value.trim();
    const mmss = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
    if (mmss) {
      if (mmss[3] !== undefined) {
        return ((Number(mmss[1]) * 60 * 60) + (Number(mmss[2]) * 60) + Number(mmss[3])) * 1000;
      }
      return ((Number(mmss[1]) * 60) + Number(mmss[2])) * 1000;
    }
  }

  const n = finiteNumber(value, 0);
  if (n <= 0) return 0;
  return n < 10000 ? Math.round(n * 1000) : Math.round(n);
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
  booleanFlag,
  durationToMs,
  finiteNumber,
  normalizeDifficultyToModeKey,
  normalizeKey,
};
