"use strict";

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function clampNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanShortString(value, max = 80) {
  return String(value || "").trim().slice(0, max);
}

function cleanNumberObject(raw, allowedKeys, opts = {}) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of allowedKeys) {
    if (!(key in raw)) continue;
    out[key] = clampNumber(raw[key], opts);
  }
  return out;
}

function cleanLimitedList(raw, max, cleanItem) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, max)
    .map(cleanItem)
    .filter(Boolean);
}

function clampObjectKeys(target, keys, opts = {}) {
  if (!target || typeof target !== "object") return target;
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (key in target) target[key] = clampNumber(target[key], opts);
  }
  return target;
}

function applyClampRules(target, rules) {
  for (const [keys, opts] of rules) clampObjectKeys(target, keys, opts);
  return target;
}

function roleForClass(className, fallback = "unknown") {
  const key = normalizeKey(className).replace(/\s+/g, "");
  if (key === "bard" || key === "paladin" || key === "artist" || key === "valkyrie" || key === "holyknight") {
    return "support";
  }
  if (className) return "dps";
  return fallback === "support" || fallback === "dps" ? fallback : "unknown";
}

function cleanRole(value, fallback = "unknown") {
  if (value === "support" || value === "dps") return value;
  return fallback === "support" || fallback === "dps" ? fallback : "unknown";
}

function cleanAttackStyle(value) {
  return value === "back" || value === "front" || value === "hit_master" ? value : "hit_master";
}

function cleanSupporterTier(value) {
  return value === "radiant" || value === "noble" || value === "supporter" ? value : "none";
}

module.exports = {
  applyClampRules,
  clampNumber,
  cleanAttackStyle,
  cleanLimitedList,
  cleanNumberObject,
  cleanRole,
  cleanShortString,
  cleanSupporterTier,
  normalizeKey,
  roleForClass,
};
