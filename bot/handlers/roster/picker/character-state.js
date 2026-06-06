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

module.exports = {
  PRESERVED_CHARACTER_FIELDS,
  preserveRosterCharacterState,
};
