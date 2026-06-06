"use strict";

const { getAccessibleAccounts } = require("../../../services/access/access-control");

async function buildMergedAccounts(viewerDiscordId, ownAccounts, { accessibleAccounts = null } = {}) {
  const merged = Array.isArray(ownAccounts) ? ownAccounts.slice() : [];

  let accessible;
  try {
    accessible = Array.isArray(accessibleAccounts)
      ? accessibleAccounts
      : await getAccessibleAccounts(viewerDiscordId, { includeOwn: false });
  } catch (err) {
    console.warn("[raid-status] getAccessibleAccounts failed:", err.message);
    return merged;
  }

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
