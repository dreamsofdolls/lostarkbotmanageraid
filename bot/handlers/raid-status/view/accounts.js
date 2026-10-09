"use strict";

const { getAccessibleAccounts } = require("../../../services/access/access-control");

/**
 * Own accounts followed by the accounts shared with the viewer.
 * A failed share lookup rejects, so a caller can keep the shared pages it
 * already shows instead of dropping them.
 * @param {string} viewerDiscordId - the viewer
 * @param {object[]} ownAccounts - the viewer's own accounts
 * @param {object} [options]
 * @param {object[]|null} [options.accessibleAccounts] - shares already read
 * @returns {Promise<object[]>} merged accounts, shared ones tagged `_sharedFrom`
 */
async function buildMergedAccounts(viewerDiscordId, ownAccounts, { accessibleAccounts = null } = {}) {
  const merged = Array.isArray(ownAccounts) ? ownAccounts.slice() : [];

  const accessible = Array.isArray(accessibleAccounts)
    ? accessibleAccounts
    : await getAccessibleAccounts(viewerDiscordId, { includeOwn: false });

  for (const entry of accessible) {
    if (entry.isOwn) continue;
    const sourceAccount = entry.account;
    const plainAccount = sourceAccount && typeof sourceAccount.toObject === "function"
      ? sourceAccount.toObject({ depopulate: true })
      : { ...sourceAccount };
    plainAccount._sharedFrom = {
      ownerDiscordId: entry.ownerDiscordId,
      ownerLabel: entry.ownerLabel,
      accessLevel: entry.accessLevel,
    };
    merged.push(plainAccount);
  }

  return merged;
}

function resolveBackgroundLookup(viewerDiscordId, account) {
  const accountName = account?.accountName || "";
  const accountKey = String(accountName).trim().toLowerCase();
  return {
    discordId: viewerDiscordId,
    accountName,
    cacheKey: `${viewerDiscordId}:${accountKey}`,
  };
}

module.exports = {
  buildMergedAccounts,
  resolveBackgroundLookup,
};
