/**
 * services/local-sync/core/catalog.js
 * Server-side catalog snapshot served to the web companion at boot.
 * Single source of truth for boss→raid mappings + difficulty aliases so
 * server apply path and browser preview stay in sync. Versioned (v1) so
 * a future schema bump can be detected client-side without breaking
 * older companion pages.
 */

"use strict";

const { RAID_REQUIREMENTS, BOSS_TO_RAID_GATE } = require("../../../models/Raid");
const { CLASS_ID_TO_BIBLE_ID, getClassInfoByNumericId } = require("../../../models/Class");

// LOA Logs encounters.db `difficulty` values vs Artist's internal modeKey.
// Kept here so the server apply path and the web companion catalog share one
// source instead of drifting when LOA Logs changes wording.
const DIFFICULTY_TO_MODE_KEY = Object.freeze({
  normal: "normal",
  "level 1": "normal",
  level1: "normal",
  l1: "normal",
  hard: "hard",
  "level 2": "hard",
  level2: "hard",
  l2: "hard",
  nightmare: "nightmare",
  "level 3": "nightmare",
  level3: "nightmare",
  l3: "nightmare",
  trial: "nightmare",
  inferno: "nightmare",
});

/**
 * Map a LOA Logs `difficulty` value to Artist's internal modeKey.
 * @param {string} raw - LOA Logs raw difficulty string (e.g. "Hard")
 * @returns {"normal"|"hard"|"nightmare"|null} normalized mode key, or null when unrecognized
 */
function normalizeDifficulty(raw) {
  const text = String(raw || "").trim().toLowerCase();
  return DIFFICULTY_TO_MODE_KEY[text] || null;
}

/**
 * Build the catalog snapshot the web companion fetches at page load.
 * Pure compute over the in-memory raid + class registries · no DB hits,
 * safe to call on every request (catalog-endpoint also caches via
 * Cache-Control: max-age=300).
 * @returns {{version: number, raidOrder: string[], modeOrder: string[], raids: object, bossToRaidGate: Array, difficultyToModeKey: object, classesById: object}}
 */
function buildLocalSyncCatalog() {
  const raids = {};
  const modeOrder = [];
  for (const [raidKey, raid] of Object.entries(RAID_REQUIREMENTS)) {
    const modes = {};
    for (const [modeKey, mode] of Object.entries(raid.modes || {})) {
      if (!modeOrder.includes(modeKey)) modeOrder.push(modeKey);
      modes[modeKey] = {
        label: mode.label,
        minItemLevel: Number(mode.minItemLevel) || 0,
      };
    }
    raids[raidKey] = {
      label: raid.label,
      gates: Array.isArray(raid.gates) ? [...raid.gates] : ["G1", "G2"],
      modes,
    };
  }

  const classesById = {};
  for (const classId of Object.keys(CLASS_ID_TO_BIBLE_ID)) {
    const classInfo = getClassInfoByNumericId(classId);
    classesById[classId] = {
      bibleId: classInfo.bibleId,
      label: classInfo.className,
      icon: classInfo.bibleId,
    };
  }

  return {
    version: 1,
    raidOrder: Object.keys(RAID_REQUIREMENTS),
    modeOrder,
    raids,
    bossToRaidGate: [...BOSS_TO_RAID_GATE.entries()].map(([boss, target]) => [
      boss,
      { raidKey: target.raidKey, gate: target.gate },
    ]),
    difficultyToModeKey: { ...DIFFICULTY_TO_MODE_KEY },
    classesById,
  };
}

module.exports = {
  DIFFICULTY_TO_MODE_KEY,
  normalizeDifficulty,
  buildLocalSyncCatalog,
};
