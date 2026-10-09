"use strict";

const {
  buildPickedCharacterRecord,
  summarizeSavedCharacter,
} = require("../picker/character-state");

function getSessionBibleNameSet(session) {
  return session.bibleNames instanceof Set ? session.bibleNames : new Set();
}

function findSeedOrSelectionAccount({ accounts, normalizedSeed, rosterNameSet, normalizeName, getCharacterName }) {
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
  bibleNameSet,
  normalizeName,
  getCharacterName,
}) {
  if (bibleNameSet.size === 0) return null;
  return (accounts || []).find((item) => {
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

function appendAddRosterAccount({ userDoc, session }) {
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


function buildSavedAccountSnapshot({ account, getCharacterName, getCharacterClass }) {
  return {
    accountName: account.accountName,
    characters: account.characters.map((character) => summarizeSavedCharacter(
      character,
      { getCharacterName, getCharacterClass }
    )),
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
}) {
  async function persistSelectedRoster(session, selectedChars) {
    const rosterNameSet = new Set(selectedChars.map((c) => normalizeName(c.charName)));
    const bibleNameSet = getSessionBibleNameSet(session);
    let savedAccount;

    await saveWithRetry(async () => {
      let userDoc = await User.findOne({ discordId: session.discordId });
      if (!userDoc) {
        // First roster onboarding starts in Local Sync mode. Keep this on the
        // new-document branch only: adding or refreshing a roster later must
        // never override a user's explicit sync-mode choice.
        userDoc = new User({
          discordId: session.discordId,
          accounts: [],
          autoManageEnabled: false,
          localSyncEnabled: true,
        });
      }
      ensureFreshWeek(userDoc);

      // The command refuses a roster that is already saved, so an account
      // matching this seed, selection or Bible roster here was saved by a
      // concurrent picker after that check. Refuse it rather than replace
      // the characters that picker saved.
      const collidingAccount = findSeedOrSelectionAccount({
        accounts: userDoc.accounts,
        normalizedSeed: normalizeName(session.seedCharName),
        rosterNameSet,
        normalizeName,
        getCharacterName,
      }) || findCollidingBibleRosterAccount({
        accounts: userDoc.accounts,
        bibleNameSet,
        normalizeName,
        getCharacterName,
      });
      if (collidingAccount) {
        throw createDuplicateRosterError(collidingAccount.accountName);
      }

      const account = appendAddRosterAccount({ userDoc, session });
      account.characters = selectedChars.map((character) => buildPickedCharacterRecord(
        character,
        null,
        { buildCharacterRecord, createCharacterId }
      ));
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
  createAddRosterPersistence,
};
