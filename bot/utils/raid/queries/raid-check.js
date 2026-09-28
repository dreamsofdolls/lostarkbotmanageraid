/**
 * utils/raid/queries/raid-check.js
 * Field projection for the /raid-check Manager view's User scans
 * (handlers/raid-check/all-mode).
 */

// Narrow Mongo payload for /raid-check scans. The view only needs roster
// fields, refresh stamps, weekly cursor and auto-manage badges; the rest of
// the User document stays excluded.
const RAID_CHECK_USER_QUERY_FIELDS = [
  "discordId",
  "weeklyResetKey",
  "autoManageEnabled",
  "localSyncEnabled",
  "lastAutoManageSyncAt",
  "lastAutoManageAttemptAt",
  "accounts.accountName",
  "accounts.lastRefreshedAt",
  "accounts.lastRefreshAttemptAt",
  "accounts.characters.name",
  "accounts.characters.charName",
  "accounts.characters.class",
  "accounts.characters.className",
  "accounts.characters.itemLevel",
  "accounts.characters.raids",
  "accounts.characters.assignedRaids",
  "accounts.characters.publicLogDisabled",
  "discordUsername",
  "discordGlobalName",
  "discordDisplayName",
].join(" ");

module.exports = {
  RAID_CHECK_USER_QUERY_FIELDS,
};
