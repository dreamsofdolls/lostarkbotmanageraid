"use strict";

const {
  normalizeKey,
} = require("../bible-log-utils");

const SUPPORT_CLASS_KEYS = new Set([
  "artist",
  "bard",
  "paladin",
  "holyknight",
  "holy knight",
  "valkyrie",
]);
const SUPPORT_MAIN_SPEC_KEYS = new Set([
  "blessedaura",
  "desperatesalvation",
  "fullbloom",
  "liberator",
]);
const SUPPORT_DPS_SPEC_KEYS = new Set([
  "judgment",
  "truecourage",
  "recurrence",
  "shiningknight",
]);

function compactKey(value) {
  return normalizeKey(value).replace(/[^a-z0-9]/g, "");
}

function classRoleFor(className) {
  const key = normalizeKey(className);
  if (SUPPORT_CLASS_KEYS.has(key) || SUPPORT_CLASS_KEYS.has(compactKey(className))) return "support";
  return key ? "dps" : "unknown";
}

function roleForLog(className, spec) {
  const classRole = classRoleFor(className);
  if (classRole !== "support") return classRole;
  const specKey = compactKey(spec);
  if (SUPPORT_DPS_SPEC_KEYS.has(specKey)) return "dps";
  if (SUPPORT_MAIN_SPEC_KEYS.has(specKey)) return "support";
  return "support";
}

module.exports = {
  classRoleFor,
  compactKey,
  roleForLog,
};
