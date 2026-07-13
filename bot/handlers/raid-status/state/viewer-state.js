"use strict";

const { getAccessibleAccounts } = require("../../../services/access/access-control");
const { getUserLanguage } = require("../../../services/i18n");

const LOCAL_SYNC_PROBE_BUDGET_MS = 750;

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

async function probeLocalSyncModeWithBudget({
  User,
  discordId,
  waitWithBudget,
  budgetMs = LOCAL_SYNC_PROBE_BUDGET_MS,
  log = console,
}) {
  const probePromise = probeLocalSyncMode({ User, discordId });
  if (typeof waitWithBudget !== "function" || budgetMs <= 0) {
    return await probePromise;
  }

  const result = await waitWithBudget(probePromise, budgetMs);
  if (!result.timedOut) return !!result.value;

  log.warn?.(
    `[raid-status] local-sync probe exceeded ${budgetMs}ms; deferring ephemeral to avoid Discord timeout.`
  );
  return true;
}

async function loadStatusViewerState({
  User,
  discordId,
  prepareStatusUserDoc,
  getAccessibleAccountsFn = getAccessibleAccounts,
}) {
  const incomingSharesPromise = Promise.resolve()
    .then(() =>
      getAccessibleAccountsFn(discordId, {
        includeOwn: false,
      })
    )
    .then((rows) => (Array.isArray(rows) ? rows : []))
    .catch((err) => {
      console.warn(
        "[raid-status] share check failed during viewer load:",
        err?.message || err
      );
      return [];
    });
  const [lang, seedDoc, incomingSharedAccounts] = await Promise.all([
    getUserLanguage(discordId, { UserModel: User }),
    User.findOne({ discordId }),
    incomingSharesPromise,
  ]);
  const hasOwnAccounts =
    seedDoc && Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
  const hasIncomingShare = incomingSharedAccounts.length > 0;

  if (!hasOwnAccounts && !hasIncomingShare) {
    return {
      lang,
      seedDoc,
      hasOwnAccounts,
      hasIncomingShare,
      incomingSharedAccounts,
      noRoster: true,
      piggybackOutcome: null,
      startBackgroundRefresh: null,
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
      startBackgroundRefresh: null,
      userDoc: seedDoc || { discordId, accounts: [] },
    };
  }

  const prepared = prepareStatusUserDoc(discordId, seedDoc);
  const userDoc = prepared.userDoc;
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
    piggybackOutcome: prepared.piggybackOutcome,
    startBackgroundRefresh: prepared.startBackgroundRefresh,
    userDoc,
  };
}

module.exports = {
  LOCAL_SYNC_PROBE_BUDGET_MS,
  loadStatusViewerState,
  probeLocalSyncMode,
  probeLocalSyncModeWithBudget,
};
