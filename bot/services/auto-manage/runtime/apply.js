"use strict";

function createAutoManageApplier({
  autoManageEntryKey,
  getCharacterClass,
  getCharacterName,
  isPublicLogDisabledError,
  reconcileCharacterFromLogs,
}) {
  function applyAutoManageCollected(userDoc, weekResetStart, collected) {
    const report = { appliedTotal: 0, perChar: [] };
    const byKey = new Map(collected.map((entry) => [entry.entryKey, entry]));

    for (const account of userDoc.accounts || []) {
      for (const character of account.characters || []) {
        const charName = getCharacterName(character);
        const entry = {
          accountName: account.accountName,
          charName,
          className: getCharacterClass(character),
          applied: [],
          error: null,
        };
        const gathered = byKey.get(autoManageEntryKey(account.accountName, charName));
        if (!gathered) continue;

        if (gathered.error) {
          entry.error = gathered.error;
          if (isPublicLogDisabledError(gathered.error)) {
            character.publicLogDisabled = true;
            character.publicLogDisabledAt = new Date();
          }
          report.perChar.push(entry);
          continue;
        }

        try {
          if (gathered.canonicalName && getCharacterName(character) !== gathered.canonicalName) {
            character.name = gathered.canonicalName;
            entry.charName = gathered.canonicalName;
          }
          if (gathered.meta) {
            character.bibleSerial = gathered.meta.sn;
            character.bibleCid = gathered.meta.cid;
            character.bibleRid = gathered.meta.rid;
          }
          const applied = reconcileCharacterFromLogs(
            character,
            gathered.logs || [],
            weekResetStart
          );
          entry.applied = applied;
          report.appliedTotal += applied.length;
          if (character.publicLogDisabled) {
            character.publicLogDisabled = false;
            character.publicLogDisabledAt = null;
          }
        } catch (err) {
          entry.error = err?.message || String(err);
          console.warn(
            `[auto-manage] apply for ${charName} failed:`,
            err?.message || err
          );
        }
        report.perChar.push(entry);
      }
    }

    return report;
  }

  return {
    applyAutoManageCollected,
  };
}

module.exports = {
  createAutoManageApplier,
};
