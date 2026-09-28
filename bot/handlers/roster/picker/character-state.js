"use strict";

const PRESERVED_CHARACTER_FIELDS = Object.freeze([
  "bibleSerial",
  "bibleCid",
  "bibleRid",
  "publicLogDisabled",
  "publicLogDisabledAt",
]);

function preserveRosterCharacterState(record, existing, fields = PRESERVED_CHARACTER_FIELDS) {
  if (!existing) return record;
  const source = existing.toObject?.() ?? existing;
  for (const field of fields) {
    if (
      Object.prototype.hasOwnProperty.call(source, field) &&
      source[field] !== undefined
    ) {
      record[field] = source[field];
    }
  }
  return record;
}

/**
 * The stored record for a character picked in the add or edit picker. A
 * character already on the roster keeps its saved fields (id, raids, tasks,
 * Bible identity, Public Log state); the picker's name, class, item level
 * and combat score replace the display fields.
 * @param {object} picked - picker entry ({ charName, className, itemLevel, combatScore })
 * @param {object|null} existing - the saved character with the same name
 * @param {{buildCharacterRecord: Function, createCharacterId: Function}} deps
 * @returns {object} the record to store
 */
function buildPickedCharacterRecord(picked, existing, { buildCharacterRecord, createCharacterId }) {
  const record = buildCharacterRecord(
    {
      ...(existing ? existing.toObject?.() ?? existing : {}),
      name: picked.charName,
      class: picked.className,
      itemLevel: picked.itemLevel,
      combatScore: picked.combatScore,
    },
    existing?.id || createCharacterId()
  );
  return preserveRosterCharacterState(record, existing);
}

/** The saved-card view of a stored character. */
function summarizeSavedCharacter(character, { getCharacterName, getCharacterClass }) {
  return {
    name: getCharacterName(character),
    class: getCharacterClass(character),
    itemLevel: Number(character.itemLevel) || 0,
    combatScore: character.combatScore || "",
  };
}

module.exports = {
  preserveRosterCharacterState,
  buildPickedCharacterRecord,
  summarizeSavedCharacter,
};
