/**
 * raid-check-query.js
 *
 * Mongo query construction for /raid-check scans. Pulled out of
 * raid-command.js so the field projection list and the iLvl-range filter
 * live next to the helper that builds the query, instead of being
 * scattered across 300 lines of compose-root.
 *
 * Used by: services/auto-manage-core.js, commands/raid-check.js,
 * commands/raid-status.js (anything that scans User docs for a raid view).
 */

const { RAID_REQUIREMENTS } = require("../data/Raid");
const {
  ROSTER_REFRESH_COOLDOWN_MS,
  ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
} = require("../services/roster-refresh");

// Narrow Mongo payload for /raid-check scans. The view only needs roster
// fields, refresh stamps, weekly cursor, and auto-manage badges - not the
// rest of the User document.
const RAID_CHECK_USER_BASE_QUERY = { "accounts.0": { $exists: true } };
const RAID_CHECK_USER_QUERY_FIELDS = [
  "discordId",
  "weeklyResetKey",
  "autoManageEnabled",
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
/**
 * For a given (raidKey, selfMin) compute the iLvl range bounds needed to
 * classify roster chars as eligible / too-low for the scan.
 *
 *   - lowestMin: min iLvl of the lowest-tier mode of this raid. Chars
 *     below this are outside the raid entirely and never render.
 *   - selfMin: scan mode's own min (usually === `raidMeta.minItemLevel`).
 *   - nextMin: min iLvl of the next higher mode. Chars at or above this
 *     floor have out-grown the selected mode and should not show in that
 *     mode's scan page.
 *
 * The `lowestMin` floor uses `Math.min(RAID_REQ lowest, selfMin)` so that
 * if a caller passes a selfMin below the actual lowest mode (e.g. older
 * tests), the range still degrades gracefully instead of hiding every
 * char.
 */
function getRaidScanRange(raidKey, selfMin) {
  const modes = RAID_REQUIREMENTS[raidKey]?.modes || {};
  const mins = Object.values(modes)
    .map((m) => Number(m.minItemLevel))
    .filter(Number.isFinite);
  const baseLowest = mins.length > 0 ? Math.min(...mins) : selfMin;
  const lowestMin = Math.min(baseLowest, selfMin);
  const higherMins = mins
    .filter((min) => min > selfMin)
    .sort((a, b) => a - b);
  const nextMin = higherMins.length > 0 ? higherMins[0] : Infinity;
  return { lowestMin, selfMin, nextMin };
}

function buildRaidCheckUserQuery(raidMeta, now = Date.now()) {
  const query = { ...RAID_CHECK_USER_BASE_QUERY };
  if (!raidMeta) return query;

  const { lowestMin } = getRaidScanRange(
    raidMeta.raidKey,
    Number(raidMeta.minItemLevel) || 0
  );
  if (Number.isFinite(lowestMin) && lowestMin > 0) {
    const refreshCutoff = now - ROSTER_REFRESH_COOLDOWN_MS;
    const failureCutoff = now - ROSTER_REFRESH_FAILURE_COOLDOWN_MS;
    // Keep stale/unrefreshed accounts in the candidate set even when their
    // cached iLvl is below the raid floor. Initial /raid-check intentionally
    // lazy-refreshes stale roster metadata before scanning; filtering only
    // by cached iLvl here would hide a character who honed past the floor
    // since the last successful refresh.
    query.$or = [
      { "accounts.characters.itemLevel": { $gte: lowestMin } },
      {
        accounts: {
          $elemMatch: {
            $and: [
              {
                $or: [
                  { lastRefreshedAt: null },
                  { lastRefreshedAt: { $exists: false } },
                  { lastRefreshedAt: { $lt: refreshCutoff } },
                ],
              },
              {
                $or: [
                  { lastRefreshAttemptAt: null },
                  { lastRefreshAttemptAt: { $exists: false } },
                  { lastRefreshAttemptAt: { $lt: failureCutoff } },
                ],
              },
            ],
          },
        },
      },
    ];
  }
  return query;
}

module.exports = {
  RAID_CHECK_USER_BASE_QUERY,
  RAID_CHECK_USER_QUERY_FIELDS,
  getRaidScanRange,
  buildRaidCheckUserQuery,
};
