"use strict";

const SUPPORT_CLASSES = new Set(["bard", "paladin", "artist", "valkyrie", "holyknight"]);
export const SUPPORT_DPS_PROFILE_SPEC_KEYS = ["judgment", "truecourage", "recurrence", "shiningknight"];
export const SUPPORT_MAIN_PROFILE_SPEC_KEYS = ["blessedaura", "desperatesalvation", "fullbloom", "liberator"];
const SUPPORT_DPS_BUILD_SPECS = new Set(SUPPORT_DPS_PROFILE_SPEC_KEYS);
const SUPPORT_MAIN_BUILD_SPECS = new Set(SUPPORT_MAIN_PROFILE_SPEC_KEYS);

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function stripMarkup(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeProfileSpecKey(value) {
  return normalizeName(stripMarkup(value)).replace(/[^a-z0-9]+/g, "");
}

export function roleForProfileClass(className) {
  const key = normalizeName(className).replace(/\s+/g, "");
  if (SUPPORT_CLASSES.has(key)) return "support";
  return className ? "dps" : "unknown";
}

export function classifyProfileLogRole(row) {
  if (row?.classRole !== "support") return row?.classRole || "unknown";

  const specKey = normalizeProfileSpecKey(row.arkPassive?.enlightenment?.spec || row.spec);
  if (SUPPORT_MAIN_BUILD_SPECS.has(specKey)) return "support";
  if (SUPPORT_DPS_BUILD_SPECS.has(specKey)) return "dps";

  const partyCount = Number(row.partyCount) || 0;
  const damageShare = Number(row.damageShare) || 0;
  const damageRank = Number(row.damageRank) || 0;
  const expectedShare = partyCount > 0 ? 100 / partyCount : 12.5;
  const shareLooksDps = damageShare >= Math.max(6, expectedShare * 0.45);
  const rankLooksDps =
    partyCount > 1 &&
    damageRank > 0 &&
    damageRank <= Math.ceil(partyCount * 0.5) &&
    damageShare >= Math.max(4, expectedShare * 0.25);

  if (shareLooksDps || rankLooksDps) return "dps";
  return "support";
}
