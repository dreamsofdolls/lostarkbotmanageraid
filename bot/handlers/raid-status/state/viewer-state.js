"use strict";

const { getAccessibleAccounts } = require("../../../services/access/access-control");
const { getUserLanguage } = require("../../../services/i18n");

const LOCAL_SYNC_PROBE_BUDGET_MS = 750;

function loadStatusSeedDoc({ User, discordId }) {
  const query = User.findOne({ discordId });
  return typeof query?.lean === "function" ? query.lean() : query;
}

function loadIncomingSharedAccounts({
  discordId,
  getAccessibleAccountsFn = getAccessibleAccounts,
}) {
  return Promise.resolve()
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
}

async function probeLocalSyncMode({ User, discordId }) {
  try {
    const probe = await User.findOne({ discordId })
      .select("localSyncEnabled")
      .lean();
    return !!probe?.localSyncEnabled;
  } catch (err) {
    console.warn("[raid-status] localSync probe failed:", err?.message || err);
    return true;
  }
}

async function probeLocalSyncModeWithBudget({
  User,
  discordId,
  probePromise = null,
  waitWithBudget,
  budgetMs = LOCAL_SYNC_PROBE_BUDGET_MS,
  log = console,
}) {
  const pendingProbe = probePromise || probeLocalSyncMode({ User, discordId });
  if (typeof waitWithBudget !== "function" || budgetMs <= 0) {
    return await pendingProbe;
  }

  const result = await waitWithBudget(pendingProbe, budgetMs);
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
  seedDocPromise = null,
  incomingSharesPromise = null,
}) {
  const pendingSeedDoc =
    seedDocPromise || Promise.resolve().then(() => loadStatusSeedDoc({ User, discordId }));
  const pendingIncomingShares =
    incomingSharesPromise ||
    loadIncomingSharedAccounts({ discordId, getAccessibleAccountsFn });
  const [seedDoc, incomingSharedAccounts] = await Promise.all([
    pendingSeedDoc,
    pendingIncomingShares,
  ]);
  const lang = await getUserLanguage(discordId, {
    UserModel: User,
    userDoc: seedDoc,
  });
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

function createStatusViewerStateLoader({
  User,
  discordId,
  prepareStatusUserDoc,
  getAccessibleAccountsFn = getAccessibleAccounts,
}) {
  const seedDocPromise = Promise.resolve().then(() =>
    loadStatusSeedDoc({ User, discordId })
  );
  const incomingSharesPromise = loadIncomingSharedAccounts({
    discordId,
    getAccessibleAccountsFn,
  });
  const localSyncModePromise = seedDocPromise
    .then((seedDoc) => !!seedDoc?.localSyncEnabled)
    .catch((err) => {
      console.warn("[raid-status] shared localSync probe failed:", err?.message || err);
      return true;
    });
  let viewerStatePromise = null;

  return {
    probeLocalSyncMode() {
      return localSyncModePromise;
    },
    load() {
      if (!viewerStatePromise) {
        viewerStatePromise = loadStatusViewerState({
          User,
          discordId,
          prepareStatusUserDoc,
          getAccessibleAccountsFn,
          seedDocPromise,
          incomingSharesPromise,
        });
      }
      return viewerStatePromise;
    },
  };
}

module.exports = {
  LOCAL_SYNC_PROBE_BUDGET_MS,
  createStatusViewerStateLoader,
  loadStatusViewerState,
  probeLocalSyncMode,
  probeLocalSyncModeWithBudget,
};
