"use strict";

const {
  normalizeKey,
} = require("./common");

const ENTRY_SEP = "\x1f";

function buildRosterIndexes(userDoc) {
  const byAccountChar = new Map();
  const byChar = new Map();
  for (const account of userDoc?.accounts || []) {
    const accountName = account?.accountName || "";
    for (const character of account?.characters || []) {
      const charName = character?.name || character?.charName || "";
      const charKey = normalizeKey(charName);
      if (!charKey) continue;
      const entry = { account, accountName, character, charName };
      byAccountChar.set(`${normalizeKey(accountName)}${ENTRY_SEP}${charKey}`, entry);
      if (!byChar.has(charKey)) byChar.set(charKey, entry);
    }
  }
  return { byAccountChar, byChar };
}

function resolveRosterCharacter(indexes, accountName, charName) {
  const accountCharKey = `${normalizeKey(accountName)}${ENTRY_SEP}${normalizeKey(charName)}`;
  return indexes.byAccountChar.get(accountCharKey) || indexes.byChar.get(normalizeKey(charName)) || null;
}

module.exports = {
  buildRosterIndexes,
  resolveRosterCharacter,
};
