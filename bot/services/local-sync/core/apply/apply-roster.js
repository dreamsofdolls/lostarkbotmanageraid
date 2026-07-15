"use strict";

const {
  getCharacterName,
  normalizeName,
  toModeLabel,
} = require("../../../../utils/raid/common/shared");
const {
  getGatesForRaid,
  preserveManualRaidModePreference,
} = require("../../../../models/Raid");
const { normalizeDifficulty } = require("../catalog");
const { COMPANION_SCOPE } = require("../scope");

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

function resolveBucketModePreference(userDoc, bucket) {
  const character = findRosterCharacter(userDoc, bucket?.charName);
  if (!character) return bucket;
  const storedModeKey = getAssignedRaid(character, bucket.raidKey)?.modeKey;
  const modeKey = preserveManualRaidModePreference(
    storedModeKey,
    bucket.modeKey,
    bucket.raidKey
  );
  return modeKey && modeKey !== bucket.modeKey
    ? { ...bucket, modeKey }
    : bucket;
}

function isCurrentWeekCompletion(value, currentWeekStartMs = 0) {
  const completedAt = Number(value);
  return completedAt > 0 && completedAt >= currentWeekStartMs;
}

function raidAlreadyComplete(character, raidKey, currentWeekStartMs = 0) {
  const assignedRaid = getAssignedRaid(character, raidKey);
  const gates = getGatesForRaid(raidKey);
  return gates.length > 0 && gates.every((gate) => (
    isCurrentWeekCompletion(assignedRaid?.[gate]?.completedDate, currentWeekStartMs)
  ));
}

function gatesAlreadyComplete(character, bucket, effectiveGates, currentWeekStartMs = 0) {
  const selectedDifficulty = normalizeName(toModeLabel(bucket.modeKey));
  const assignedRaid = getAssignedRaid(character, bucket.raidKey);
  if (!Array.isArray(effectiveGates) || effectiveGates.length === 0) return false;
  return effectiveGates.every((gate) => {
    const entry = assignedRaid?.[gate];
    if (!isCurrentWeekCompletion(entry?.completedDate, currentWeekStartMs)) return false;
    const entryDifficulty = normalizeName(entry?.difficulty || "");
    return !entryDifficulty || entryDifficulty === selectedDifficulty;
  });
}

function hasCurrentWeekProgressInAnotherMode(
  character,
  bucket,
  currentWeekStartMs = 0
) {
  const assignedRaid = getAssignedRaid(character, bucket.raidKey);
  const storedModeKey = normalizeDifficulty(
    assignedRaid?.modeKey || getGatesForRaid(bucket.raidKey)
      .map((gate) => assignedRaid?.[gate]?.difficulty)
      .find(Boolean)
  );
  if (!storedModeKey || storedModeKey === bucket.modeKey) return false;
  return getGatesForRaid(bucket.raidKey).some((gate) => (
    isCurrentWeekCompletion(assignedRaid?.[gate]?.completedDate, currentWeekStartMs)
  ));
}

function classifyBucketAgainstRoster(
  userDoc,
  bucket,
  raidMeta,
  effectiveGates,
  { currentWeekStartMs = 0, requiredCompanionScope = null } = {}
) {
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    return { action: "reject", reason: "no_roster" };
  }

  const character = findRosterCharacter(userDoc, bucket.charName);
  if (!character) return { action: "reject", reason: "char_not_in_roster" };

  const charItemLevel = Number(character.itemLevel) || 0;
  if (charItemLevel < raidMeta.minItemLevel) {
    return { action: "reject", reason: "ilvl_too_low", ineligibleItemLevel: charItemLevel };
  }

  if (
    requiredCompanionScope === COMPANION_SCOPE.solo
    && hasCurrentWeekProgressInAnotherMode(character, bucket, currentWeekStartMs)
  ) {
    return { action: "reject", reason: "mode_progress_conflict" };
  }

  if (raidAlreadyComplete(character, bucket.raidKey, currentWeekStartMs)) {
    return {
      action: "skip",
      reason: "already_complete",
      displayName: getCharacterName(character) || bucket.charName,
    };
  }

  if (gatesAlreadyComplete(character, bucket, effectiveGates, currentWeekStartMs)) {
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
  hasCurrentWeekProgressInAnotherMode,
  isCurrentWeekCompletion,
  raidAlreadyComplete,
  resolveBucketModePreference,
};
