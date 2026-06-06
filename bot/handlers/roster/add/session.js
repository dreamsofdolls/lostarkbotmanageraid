"use strict";

const { PICKER_MAX_OPTIONS } = require("./constants");

function buildBibleNameSet(rosterCharacters, normalizeName) {
  return new Set(rosterCharacters.map((character) => normalizeName(character.charName)));
}

function findDuplicateBySeed({ accounts, seedCharName, normalizeName, getCharacterName }) {
  const normalizedSeed = normalizeName(seedCharName);
  return (Array.isArray(accounts) ? accounts : []).find((account) => {
    if (normalizeName(account.accountName) === normalizedSeed) return true;
    const chars = Array.isArray(account.characters) ? account.characters : [];
    return chars.some((character) => normalizeName(getCharacterName(character)) === normalizedSeed);
  }) || null;
}

function findDuplicateByBibleNames({ accounts, bibleNameSet, normalizeName, getCharacterName }) {
  return (Array.isArray(accounts) ? accounts : []).find((account) => {
    const chars = Array.isArray(account.characters) ? account.characters : [];
    return chars.some((character) =>
      bibleNameSet.has(normalizeName(getCharacterName(character)))
    );
  }) || null;
}

function sortRosterCharacters(rosterCharacters, { parseCombatScore }) {
  return [...rosterCharacters].sort((a, b) => {
    const combatDiff = parseCombatScore(b.combatScore) - parseCombatScore(a.combatScore);
    if (combatDiff !== 0) return combatDiff;
    return b.itemLevel - a.itemLevel;
  });
}

function toSessionCharacter(character) {
  return {
    charName: character.charName,
    className: character.className,
    itemLevel: character.itemLevel,
    combatScore: character.combatScore,
  };
}

function buildAddRosterSession({
  sessionId,
  callerId,
  lang,
  targetUser,
  discordId,
  actingForOther,
  seedCharName,
  rosterCharacters,
  bibleNameSet,
  parseCombatScore,
}) {
  const sortedChars = sortRosterCharacters(rosterCharacters, { parseCombatScore });
  const displayChars = sortedChars.slice(0, PICKER_MAX_OPTIONS);
  const selectedIndices = new Set(displayChars.map((_, index) => index));
  return {
    truncated: sortedChars.length > PICKER_MAX_OPTIONS,
    sortedCount: sortedChars.length,
    session: {
      sessionId,
      callerId,
      lang,
      targetId: targetUser?.id || null,
      discordId,
      actingForOther,
      seedCharName,
      bibleNames: bibleNameSet,
      chars: displayChars.map(toSessionCharacter),
      selectedIndices,
      expireTimer: null,
    },
  };
}

module.exports = {
  buildAddRosterSession,
  buildBibleNameSet,
  findDuplicateByBibleNames,
  findDuplicateBySeed,
  sortRosterCharacters,
};
