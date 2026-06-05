"use strict";

const {
  finiteNumber,
  normalizeKey,
} = require("../bible-log-utils");
const {
  ENTRY_SEP,
} = require("./constants");
const {
  classRoleFor,
} = require("./role");

function buildRosterIndex(userDoc, { getCharacterName, getCharacterClass }) {
  const byEntryKey = new Map();
  for (const account of userDoc?.accounts || []) {
    const accountName = String(account?.accountName || "").trim();
    for (const character of account?.characters || []) {
      const charName = getCharacterName(character);
      if (!accountName || !charName) continue;
      const entryKey = `${normalizeKey(accountName)}${ENTRY_SEP}${normalizeKey(charName)}`;
      byEntryKey.set(entryKey, {
        accountName,
        charName,
        className: getCharacterClass(character),
        itemLevel: finiteNumber(character?.itemLevel, 0),
        character,
      });
    }
  }
  return byEntryKey;
}

function buildRosterSummaryIndexes(userDoc, { getCharacterName, getCharacterClass }) {
  const byEntryKey = new Map();
  const byCharKey = new Map();
  for (const account of userDoc?.accounts || []) {
    const accountName = String(account?.accountName || "").trim();
    for (const character of account?.characters || []) {
      const charName = getCharacterName(character);
      if (!accountName || !charName) continue;
      const entry = {
        accountName,
        charName,
        className: getCharacterClass(character),
        itemLevel: finiteNumber(character?.itemLevel, 0),
      };
      byEntryKey.set(`${normalizeKey(accountName)}${ENTRY_SEP}${normalizeKey(charName)}`, entry);
      if (!byCharKey.has(normalizeKey(charName))) byCharKey.set(normalizeKey(charName), entry);
    }
  }
  return { byEntryKey, byCharKey };
}

function filterSummariesForCurrentRoster(summaries, userDoc, deps) {
  const indexes = buildRosterSummaryIndexes(userDoc, deps);
  return (summaries || []).map((summary) => {
    const accountName = String(summary?.accountName || "").trim();
    const charName = String(summary?.characterName || "").trim();
    const entry = indexes.byEntryKey.get(`${normalizeKey(accountName)}${ENTRY_SEP}${normalizeKey(charName)}`) ||
      indexes.byCharKey.get(normalizeKey(charName));
    if (!entry) return null;
    return {
      ...summary,
      accountName: entry.accountName,
      characterName: entry.charName,
      characterNameKey: normalizeKey(entry.charName),
      class: summary.class || entry.className || "",
      itemLevel: finiteNumber(summary.itemLevel, 0) || entry.itemLevel || 0,
      classRole: summary.classRole || classRoleFor(summary.class || entry.className),
    };
  }).filter(Boolean);
}

module.exports = {
  buildRosterIndex,
  filterSummariesForCurrentRoster,
};
