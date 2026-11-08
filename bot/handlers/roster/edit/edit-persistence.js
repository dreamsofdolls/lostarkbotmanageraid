"use strict";

const {
  buildPickedCharacterRecord,
  summarizeSavedCharacter,
} = require("../picker/character-state");
const { findAccountByName } = require("../../../utils/user-doc");

function createPersistEditedRoster({
  User,
  buildCharacterRecord,
  createCharacterId,
  ensureFreshWeek,
  getCharacterClass,
  getCharacterName,
  normalizeName,
  saveWithRetry,
}) {
  return async function persistEditedRoster(session, selectedChars) {
    const summary = { added: [], removed: [], kept: [], finalChars: [] };
    const preservedKeys = session.preservedSavedKeys || new Set();

    await saveWithRetry(async () => {
      const userDoc = await User.findOne({ discordId: session.discordId });
      if (!userDoc) throw new Error("User document disappeared between command and confirm.");
      ensureFreshWeek(userDoc);

      const account = findAccountByName(userDoc, session.accountName, normalizeName);
      if (!account) {
        // Coded, so the Confirm handler can answer with the localized
        // not-found notice in the caller's language.
        const error = new Error(`Roster '${session.accountName}' no longer exists.`);
        error.code = "ROSTER_NOT_FOUND";
        throw error;
      }

      const existingMap = new Map(
        (account.characters || []).map((character) => [
          normalizeName(getCharacterName(character)),
          character,
        ])
      );
      // A row of a character renamed in game carries the saved name as its
      // savedKey and the new name as charName; the saved record is found by
      // savedKey, so Save renames it instead of replacing it.
      const savedKeyOf = (character) => character.savedKey || normalizeName(character.charName);
      const selectedNameSet = new Set(selectedChars.map(savedKeyOf));

      summary.added = [];
      summary.removed = [];
      summary.kept = [];

      for (const [key, oldChar] of existingMap.entries()) {
        if (preservedKeys.has(key)) continue;
        if (!selectedNameSet.has(key)) {
          summary.removed.push(summarizeSavedCharacter(oldChar, { getCharacterName, getCharacterClass }));
        }
      }

      const preservedChars = [];
      for (const [key, oldChar] of existingMap.entries()) {
        if (preservedKeys.has(key)) preservedChars.push(oldChar);
      }

      const editedChars = selectedChars.map((character) => {
        const key = savedKeyOf(character);
        const existing = existingMap.get(key);
        const renamed = Boolean(existing) && key !== normalizeName(character.charName);
        if (existing) {
          summary.kept.push(renamed ? character.charName : getCharacterName(existing));
        } else {
          summary.added.push(character.charName);
        }

        const record = buildPickedCharacterRecord(character, existing, {
          buildCharacterRecord,
          createCharacterId,
        });
        if (renamed) {
          record.renamedFrom = getCharacterName(existing);
          record.renamedAt = Date.now();
        }
        return record;
      });

      account.characters = [...preservedChars, ...editedChars];
      account.lastRefreshedAt = Date.now();
      await userDoc.save();

      summary.finalChars = account.characters.map((character) => summarizeSavedCharacter(
        character,
        { getCharacterName, getCharacterClass }
      ));
    });

    return summary;
  };
}

module.exports = {
  createPersistEditedRoster,
};
