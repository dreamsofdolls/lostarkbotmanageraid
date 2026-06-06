"use strict";

function createPersistEditedRoster({
  User,
  buildCharacterRecord,
  createCharacterId,
  ensureFreshWeek,
  getCharacterClass,
  getCharacterName,
  normalizeName,
  preserveRosterCharacterState,
  saveWithRetry,
}) {
  return async function persistEditedRoster(session, selectedChars) {
    const summary = { added: [], removed: [], kept: [], finalChars: [] };
    const preservedKeys = session.preservedSavedKeys || new Set();

    await saveWithRetry(async () => {
      const userDoc = await User.findOne({ discordId: session.discordId });
      if (!userDoc) throw new Error("User document disappeared between command and confirm.");
      ensureFreshWeek(userDoc);

      const account = userDoc.accounts.find(
        (item) => normalizeName(item.accountName) === normalizeName(session.accountName)
      );
      if (!account) {
        throw new Error(`Roster '${session.accountName}' không còn tồn tại.`);
      }

      const existingMap = new Map(
        (account.characters || []).map((character) => [
          normalizeName(getCharacterName(character)),
          character,
        ])
      );
      const selectedNameSet = new Set(
        selectedChars.map((character) => normalizeName(character.charName))
      );

      summary.added = [];
      summary.removed = [];
      summary.kept = [];

      for (const [key, oldChar] of existingMap.entries()) {
        if (preservedKeys.has(key)) continue;
        if (!selectedNameSet.has(key)) {
          summary.removed.push(getCharacterName(oldChar));
        }
      }

      const preservedChars = [];
      for (const [key, oldChar] of existingMap.entries()) {
        if (preservedKeys.has(key)) preservedChars.push(oldChar);
      }

      const editedChars = selectedChars.map((character) => {
        const key = normalizeName(character.charName);
        const existing = existingMap.get(key);
        if (existing) {
          summary.kept.push(getCharacterName(existing));
        } else {
          summary.added.push(character.charName);
        }

        const existingPlain = existing ? existing.toObject?.() ?? existing : {};
        const record = buildCharacterRecord(
          {
            ...existingPlain,
            name: character.charName,
            class: character.className,
            itemLevel: character.itemLevel,
            combatScore: character.combatScore,
          },
          existing?.id || createCharacterId()
        );
        return preserveRosterCharacterState(record, existing);
      });

      account.characters = [...preservedChars, ...editedChars];
      account.lastRefreshedAt = Date.now();
      await userDoc.save();

      summary.finalChars = account.characters.map((character) => ({
        name: getCharacterName(character),
        class: getCharacterClass(character),
        itemLevel: Number(character.itemLevel) || 0,
        combatScore: character.combatScore || "",
      }));
    });

    return summary;
  };
}

module.exports = {
  createPersistEditedRoster,
};
