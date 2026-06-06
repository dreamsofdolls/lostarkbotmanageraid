"use strict";

function getSessionBibleNameSet(session) {
  return session.bibleNames instanceof Set ? session.bibleNames : new Set();
}

function findAddRosterMergeAccount({ accounts, normalizedSeed, rosterNameSet, normalizeName, getCharacterName }) {
  return (accounts || []).find((item) => {
    if (normalizeName(item.accountName) === normalizedSeed) return true;
    const chars = Array.isArray(item.characters) ? item.characters : [];
    if (chars.some((character) => normalizeName(getCharacterName(character)) === normalizedSeed)) {
      return true;
    }
    return chars.some((character) =>
      rosterNameSet.has(normalizeName(getCharacterName(character)))
    );
  });
}

function findCollidingBibleRosterAccount({
  accounts,
  targetAccount,
  bibleNameSet,
  normalizeName,
  getCharacterName,
}) {
  if (bibleNameSet.size === 0) return null;
  return (accounts || []).find((item) => {
    if (targetAccount && item === targetAccount) return false;
    const chars = Array.isArray(item.characters) ? item.characters : [];
    return chars.some((character) =>
      bibleNameSet.has(normalizeName(getCharacterName(character)))
    );
  });
}

function createDuplicateRosterError(accountName) {
  const err = new Error(
    `Roster already saved under account '${accountName}' by a concurrent /raid-add-roster session.`
  );
  err.code = "RACE_DUP_ROSTER";
  err.collidingAccountName = accountName;
  return err;
}

function ensureAddRosterTargetAccount({ userDoc, session, account }) {
  if (account) return account;

  const newAccount = {
    accountName: session.seedCharName,
    characters: [],
  };
  if (session.actingForOther && session.callerId) {
    newAccount.registeredBy = session.callerId;
  }
  userDoc.accounts.push(newAccount);
  return userDoc.accounts[userDoc.accounts.length - 1];
}

function buildExistingCharacterMap({ account, normalizeName, getCharacterName }) {
  return new Map(
    account.characters.map((character) => [
      normalizeName(getCharacterName(character)),
      character,
    ])
  );
}

function buildSelectedCharacterRecords({
  account,
  selectedChars,
  normalizeName,
  getCharacterName,
  buildCharacterRecord,
  createCharacterId,
  preserveRosterCharacterState,
}) {
  const existingMap = buildExistingCharacterMap({ account, normalizeName, getCharacterName });
  return selectedChars.map((character) => {
    const existing = existingMap.get(normalizeName(character.charName));
    const record = buildCharacterRecord(
      {
        ...(existing ? existing.toObject?.() ?? existing : {}),
        name: character.charName,
        class: character.className,
        itemLevel: character.itemLevel,
        combatScore: character.combatScore,
      },
      existing?.id || createCharacterId()
    );
    return preserveRosterCharacterState(record, existing);
  });
}

function buildSavedAccountSnapshot({ account, getCharacterName, getCharacterClass }) {
  return {
    accountName: account.accountName,
    characters: account.characters.map((character) => ({
      name: getCharacterName(character),
      class: getCharacterClass(character),
      itemLevel: Number(character.itemLevel) || 0,
      combatScore: character.combatScore || "",
    })),
  };
}

function createAddRosterPersistence({
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  buildCharacterRecord,
  createCharacterId,
  preserveRosterCharacterState,
}) {
  async function persistSelectedRoster(session, selectedChars) {
    const rosterNameSet = new Set(selectedChars.map((c) => normalizeName(c.charName)));
    const bibleNameSet = getSessionBibleNameSet(session);
    let savedAccount;

    await saveWithRetry(async () => {
      let userDoc = await User.findOne({ discordId: session.discordId });
      if (!userDoc) {
        userDoc = new User({ discordId: session.discordId, accounts: [] });
      }
      ensureFreshWeek(userDoc);

      const normalizedSeed = normalizeName(session.seedCharName);
      let account = findAddRosterMergeAccount({
        accounts: userDoc.accounts,
        normalizedSeed,
        rosterNameSet,
        normalizeName,
        getCharacterName,
      });

      const collidingAccount = findCollidingBibleRosterAccount({
        accounts: userDoc.accounts,
        targetAccount: account,
        bibleNameSet,
        normalizeName,
        getCharacterName,
      });
      if (collidingAccount) {
        throw createDuplicateRosterError(collidingAccount.accountName);
      }

      account = ensureAddRosterTargetAccount({ userDoc, session, account });
      account.characters = buildSelectedCharacterRecords({
        account,
        selectedChars,
        normalizeName,
        getCharacterName,
        buildCharacterRecord,
        createCharacterId,
        preserveRosterCharacterState,
      });
      account.lastRefreshedAt = Date.now();
      await userDoc.save();
      savedAccount = buildSavedAccountSnapshot({
        account,
        getCharacterName,
        getCharacterClass,
      });
    });

    return savedAccount;
  }

  return { persistSelectedRoster };
}

module.exports = {
  buildSavedAccountSnapshot,
  buildSelectedCharacterRecords,
  createAddRosterPersistence,
  createDuplicateRosterError,
  ensureAddRosterTargetAccount,
  findAddRosterMergeAccount,
  findCollidingBibleRosterAccount,
  getSessionBibleNameSet,
};
