"use strict";

function toPlainUserDoc(userDoc) {
  if (!userDoc) return null;
  return typeof userDoc.toObject === "function" ? userDoc.toObject() : userDoc;
}

function findAccountByName(userDoc, accountName, normalizeName) {
  const target = normalizeName(accountName);
  if (!target || !Array.isArray(userDoc?.accounts)) return null;
  return userDoc.accounts.find((account) => normalizeName(account?.accountName) === target) || null;
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

  const account = findAccountByName(userDoc, accountName, normalizeName);
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

    return {
      status: resolveManualRosterRefreshStatus({
        entry,
        userDoc: savedDoc,
        accountName: targetAccountName,
        startedAt,
        normalizeName,
      }),
      accountName: targetAccountName,
      userDoc: savedDoc,
      entry,
    };
  }

  return { runManualRosterRefresh };
}

module.exports = {
  createManualRosterRefreshRunner,
  resolveManualRosterRefreshStatus,
};
