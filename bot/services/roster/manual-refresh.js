"use strict";

const { toPlainUserDoc, findAccountByName } = require("../../utils/user-doc");

// The refresh may rename the account to the character it resolved the roster
// through (refresh.js). The old name is looked up first: when that name
// survives, the rename was skipped because another roster already had it.
function findRefreshedAccount({ entry, userDoc, accountName, normalizeName }) {
  return findAccountByName(userDoc, accountName, normalizeName)
    || (entry?.resolvedSeed ? findAccountByName(userDoc, entry.resolvedSeed, normalizeName) : null);
}

function resolveManualRosterRefreshStatus({
  entry,
  userDoc,
  accountName,
  startedAt,
  normalizeName,
}) {
  if (!userDoc) return "missing-user";
  if (!entry || entry.missing) return "missing-account";
  if (!entry.attempted) return "skipped";

  const account = findRefreshedAccount({ entry, userDoc, accountName, normalizeName });
  if (!account) return "missing-account";

  const lastSuccess = Number(account?.lastRefreshedAt) || 0;
  if (lastSuccess >= startedAt) return "updated";
  return "attempted";
}

function createManualRosterRefreshRunner({
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  collectAccountRefresh,
  applyStaleAccountRefreshes,
}) {
  if (typeof collectAccountRefresh !== "function") {
    throw new Error("[manual-roster-refresh] collectAccountRefresh required");
  }
  if (typeof applyStaleAccountRefreshes !== "function") {
    throw new Error("[manual-roster-refresh] applyStaleAccountRefreshes required");
  }

  async function runManualRosterRefresh(discordId, accountName) {
    const targetAccountName = String(accountName || "").trim();
    const seedDoc = await User.findOne({ discordId });
    if (!seedDoc) {
      return {
        status: "missing-user",
        accountName: targetAccountName,
        userDoc: null,
        entry: null,
      };
    }

    const startedAt = Date.now();
    const entry = await collectAccountRefresh(seedDoc, targetAccountName);
    const collected = entry ? [entry] : [];
    let savedDoc = null;

    await saveWithRetry(async () => {
      const fresh = await User.findOne({ discordId });
      if (!fresh) {
        savedDoc = null;
        return null;
      }

      const didFreshenWeek =
        typeof ensureFreshWeek === "function" ? ensureFreshWeek(fresh) : false;
      const didRefresh = applyStaleAccountRefreshes(fresh, collected);
      if (didRefresh && typeof fresh.markModified === "function") {
        fresh.markModified("accounts");
      }
      if (didFreshenWeek || didRefresh) await fresh.save();
      savedDoc = toPlainUserDoc(fresh);
      return savedDoc;
    });

    const refreshedAccount = savedDoc
      ? findRefreshedAccount({ entry, userDoc: savedDoc, accountName: targetAccountName, normalizeName })
      : null;
    return {
      status: resolveManualRosterRefreshStatus({
        entry,
        userDoc: savedDoc,
        accountName: targetAccountName,
        startedAt,
        normalizeName,
      }),
      accountName: refreshedAccount?.accountName || targetAccountName,
      userDoc: savedDoc,
      entry,
    };
  }

  return { runManualRosterRefresh };
}

module.exports = {
  createManualRosterRefreshRunner,
};
