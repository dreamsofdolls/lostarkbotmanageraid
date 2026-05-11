"use strict";

const { RAID_REQUIREMENTS, BOSS_TO_RAID_GATE } = require("../../models/Raid");
const { CLASS_ID_TO_BIBLE_ID, getClassInfoByNumericId } = require("../../models/Class");

// LOA Logs encounters.db `difficulty` values vs Artist's internal modeKey.
// Kept here so the server apply path and the web companion catalog share one
// source instead of drifting when LOA Logs changes wording.
const DIFFICULTY_TO_MODE_KEY = Object.freeze({
  normal: "normal",
  hard: "hard",
  nightmare: "nightmare",
  trial: "nightmare",
  inferno: "nightmare",
});

function normalizeDifficulty(raw) {
  const text = String(raw || "").trim().toLowerCase();
  return DIFFICULTY_TO_MODE_KEY[text] || null;
}

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
