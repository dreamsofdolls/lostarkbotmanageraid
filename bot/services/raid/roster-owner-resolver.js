/**
 * services/raid/roster-owner-resolver.js
 * Roster-owner resolver for shared rosters: maps a (caller, account-
 * name) pair to the User doc that actually owns the roster · the
 * caller themselves for their own accounts, the grantor for accounts
 * shared via /raid-share. Returns both the owner doc and a display
 * label so handlers can render "via @Owner" attribution consistently
 * across /raid-set, /raid-task, and the text-parser.
 */

"use strict";

function pickOwnerLabel(userDoc) {
  if (!userDoc) return "(unknown user)";
  const candidates = [
    userDoc.discordDisplayName,
    userDoc.discordGlobalName,
    userDoc.discordUsername,
  ];
  for (const candidate of candidates) {
    const trimmed = String(candidate || "").trim();
    if (trimmed) return trimmed;
  }
  return userDoc.discordId || "(unknown user)";
}

function flattenRegisteredAccounts(userDocs, executorId) {
  const out = [];
  if (!Array.isArray(userDocs)) return out;
  for (const doc of userDocs) {
    if (!doc || !Array.isArray(doc.accounts)) continue;
    const ownerLabel = pickOwnerLabel(doc);
    for (const account of doc.accounts) {
      if (account?.registeredBy !== executorId) continue;
      out.push({
        ownerDiscordId: doc.discordId,
        ownerLabel,
        account,
      });
    }
  }
  return out;
}

/**
 * Build the roster-owner resolver service.
 * @param {object} deps - injected dependencies (Mongoose User +
 *   RosterShare models, normalizeName helper · see destructure).
 * @returns {{resolveRosterOwner: Function}} a single helper that
 *   returns `{ownerDoc, ownerLabel, viaShared, sharePermission}` for
 *   a (callerDiscordId, accountName) pair.
 */
function createRosterOwnerResolver({
  User,
  normalizeName,
  loadUserForAutocomplete,
  loadAccountsRegisteredBy = async () => [],
  getAccessibleAccounts,
  log = console,
}) {
  if (!User) throw new Error("[roster-owner-resolver] User model required");
  if (typeof normalizeName !== "function") {
    throw new Error("[roster-owner-resolver] normalizeName required");
  }
  if (typeof loadUserForAutocomplete !== "function") {
    throw new Error("[roster-owner-resolver] loadUserForAutocomplete required");
  }
  if (typeof getAccessibleAccounts !== "function") {
    throw new Error("[roster-owner-resolver] getAccessibleAccounts required");
  }

  // Resolve a roster name picked in /raid-set to the user doc that
  // actually owns it. Search order:
  //   1. The executor's own accounts.
  //   2. Helper-added accounts where `registeredBy === executor.id`.
  //   3. Roster shares granted through /raid-share.
  async function resolveRosterOwner(executorId, rosterName, context = {}) {
    if (!rosterName) return null;
    const target = normalizeName(rosterName);
    const ownDoc = Object.prototype.hasOwnProperty.call(context, "ownDoc")
      ? context.ownDoc
      : await loadUserForAutocomplete(executorId);
    if (ownDoc && Array.isArray(ownDoc.accounts)) {
      const ownAccount = ownDoc.accounts.find(
        (account) => normalizeName(account.accountName) === target
      );
      if (ownAccount) {
        return {
          ownerDiscordId: executorId,
          ownerLabel: null,
          ownerDoc: ownDoc,
          account: ownAccount,
          actingForOther: false,
        };
      }
    }

    // Once the own-roster fast path misses, helper registrations and live
    // shares are independent. Start both lookups together so shared-roster
    // latency is max(A, B), not A + B. The wrapped share promise prevents an
    // unhandled rejection when a helper match lets us return early.
    const accessiblePromise = Promise.resolve()
      .then(() => getAccessibleAccounts(executorId, { includeOwn: false }))
      .then(
        (value) => ({ value }),
        (error) => ({ error })
      );
    const registeredDocs = await loadAccountsRegisteredBy(executorId);
    const flattened = flattenRegisteredAccounts(registeredDocs, executorId);
    const matches = flattened.filter(
      (entry) => normalizeName(entry.account.accountName) === target
    );
    if (matches.length === 1) {
      const ownerDoc = Array.isArray(registeredDocs)
        ? registeredDocs.find((doc) => doc?.discordId === matches[0].ownerDiscordId) || null
        : null;
      return { ...matches[0], ownerDoc, actingForOther: true };
    }
    if (matches.length > 1) {
      return { ambiguous: true, matches };
    }

    const accessibleResult = await accessiblePromise;
    if (accessibleResult.error) {
      log.warn(
        "[raid-set] getAccessibleAccounts failed:",
        accessibleResult.error?.message || accessibleResult.error
      );
      return null;
    }
    const accessible = accessibleResult.value || [];
    const sharedMatch = accessible.find(
      (entry) => !entry.isOwn && normalizeName(entry.accountName) === target
    );
    if (!sharedMatch) return null;

    // access-control already loaded the owner document to build this entry.
    // Keep a fallback for injected/legacy providers that do not expose it.
    const ownerDoc = sharedMatch.ownerDoc
      || await User.findOne({ discordId: sharedMatch.ownerDiscordId });
    if (!ownerDoc || !Array.isArray(ownerDoc.accounts)) return null;
    const ownerAccount = sharedMatch.account
      || ownerDoc.accounts.find(
        (account) => normalizeName(account.accountName) === target
      );
    if (!ownerAccount) return null;
    return {
      ownerDiscordId: sharedMatch.ownerDiscordId,
      ownerLabel: sharedMatch.ownerLabel,
      ownerDoc,
      account: ownerAccount,
      actingForOther: true,
      viaShare: true,
      shareLevel: sharedMatch.accessLevel,
    };
  }

  return {
    flattenRegisteredAccounts: (userDocs, executorId) =>
      flattenRegisteredAccounts(userDocs, executorId),
    resolveRosterOwner,
  };
}

module.exports = {
  pickOwnerLabel,
  flattenRegisteredAccounts,
  createRosterOwnerResolver,
};
