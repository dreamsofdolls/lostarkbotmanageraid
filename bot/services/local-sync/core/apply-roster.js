"use strict";

const {
  getCharacterName,
  normalizeName,
  toModeLabel,
} = require("../../../utils/raid/common/shared");

function findRosterCharacter(userDoc, charName) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
  const target = normalizeName(charName);
  if (!target) return null;
  for (const account of userDoc.accounts) {
    const chars = Array.isArray(account?.characters) ? account.characters : [];
    for (const character of chars) {
      if (normalizeName(getCharacterName(character)) === target) return character;
    }
  }
  return null;
}

function getAssignedRaid(character, raidKey) {
  return character?.assignedRaids?.[raidKey] || {};
}

function gatesAlreadyComplete(character, bucket, effectiveGates) {
  const selectedDifficulty = normalizeName(toModeLabel(bucket.modeKey));
  const assignedRaid = getAssignedRaid(character, bucket.raidKey);
  if (!Array.isArray(effectiveGates) || effectiveGates.length === 0) return false;
  return effectiveGates.every((gate) => {
    const entry = assignedRaid?.[gate];
    if (!(Number(entry?.completedDate) > 0)) return false;
    const entryDifficulty = normalizeName(entry?.difficulty || "");
    return !entryDifficulty || entryDifficulty === selectedDifficulty;
  });
}

function classifyBucketAgainstRoster(userDoc, bucket, raidMeta, effectiveGates) {
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    return { action: "reject", reason: "no_roster" };
  }

  const character = findRosterCharacter(userDoc, bucket.charName);
  if (!character) return { action: "reject", reason: "char_not_in_roster" };

  const charItemLevel = Number(character.itemLevel) || 0;
  if (charItemLevel < raidMeta.minItemLevel) {
    return { action: "reject", reason: "ilvl_too_low", ineligibleItemLevel: charItemLevel };
  }

  if (gatesAlreadyComplete(character, bucket, effectiveGates)) {
    return {
      action: "skip",
      reason: "already_complete",
      displayName: getCharacterName(character) || bucket.charName,
    };
  }

  return { action: "apply", displayName: getCharacterName(character) || bucket.charName };
}

module.exports = {
  classifyBucketAgainstRoster,
  findRosterCharacter,
  gatesAlreadyComplete,
};
