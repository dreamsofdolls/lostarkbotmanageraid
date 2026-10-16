"use strict";

/**
 * Pick the shared-roster entry a viewer writes through, from
 * `getAccessibleAccounts` entries. Own entries are skipped. Two owners can
 * share rosters with the same name; a view share would fail `canEditAccount`
 * at apply time, so an edit share wins the tie.
 * @param {object[]} entries Accessible-account entries (`isOwn`, `accountName`, `accessLevel`).
 * @param {string} rosterName Roster name the viewer picked.
 * @param {Function} normalizeName The caller's name normalization policy.
 * @returns {object|null} The preferred share entry, or null when no share matches.
 */
function findSharedRosterEntry(entries, rosterName, normalizeName) {
  const target = normalizeName(rosterName);
  const matches = entries.filter(
    (entry) => !entry.isOwn && normalizeName(entry.accountName) === target
  );
  return matches.find((entry) => entry.accessLevel === "edit") || matches[0] || null;
}

module.exports = { findSharedRosterEntry };
