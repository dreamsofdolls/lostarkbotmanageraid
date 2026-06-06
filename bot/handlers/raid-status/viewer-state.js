"use strict";

const { getAccessibleAccounts } = require("../../services/access/access-control");
const { getUserLanguage } = require("../../services/i18n");

async function probeLocalSyncMode({ User, discordId }) {
  try {
    const probe = await User.findOne({ discordId })
      .select("localSyncEnabled")
      .lean();
    return !!probe?.localSyncEnabled;
  } catch (err) {
    console.warn("[raid-status] localSync probe failed:", err?.message || err);
    return false;
  }
}

async function loadStatusViewerState({
  User,
  discordId,
  loadStatusUserDoc,
  getAccessibleAccountsFn = getAccessibleAccounts,
}) {
  const lang = await getUserLanguage(discordId, { UserModel: User });
  const seedDoc = await User.findOne({ discordId });
  const hasOwnAccounts =
    seedDoc && Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;

  let hasIncomingShare = false;
  let incomingSharedAccounts = null;
  if (!hasOwnAccounts) {
    try {
      incomingSharedAccounts = await getAccessibleAccountsFn(discordId, {
        includeOwn: false,
      });
      hasIncomingShare = incomingSharedAccounts.length > 0;
    } catch (err) {
      console.warn(
        "[raid-status] share check failed during zero-own gate:",
        err?.message || err
      );
    }
  }

  if (!hasOwnAccounts && !hasIncomingShare) {
    return {
      lang,
      seedDoc,
      hasOwnAccounts,
      hasIncomingShare,
      incomingSharedAccounts,
      noRoster: true,
      piggybackOutcome: null,
      userDoc: null,
    };
  }

  if (!hasOwnAccounts) {
    return {
      lang,
      seedDoc,
      hasOwnAccounts,
      hasIncomingShare,
      incomingSharedAccounts,
      noRoster: false,
      piggybackOutcome: null,
      userDoc: seedDoc || { discordId, accounts: [] },
    };
  }

  const refreshed = await loadStatusUserDoc(discordId, seedDoc);
  const userDoc = refreshed.userDoc;
  const noRoster =
    !hasIncomingShare &&
    (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0);

  return {
    lang,
    seedDoc,
    hasOwnAccounts,
    hasIncomingShare,
    incomingSharedAccounts,
    noRoster,
    piggybackOutcome: refreshed.piggybackOutcome,
    userDoc,
  };
}

module.exports = {
  loadStatusViewerState,
  probeLocalSyncMode,
};
