/**
 * services/raid/view-snapshot.js
 * View-snapshot service: returns a plain-object snapshot of a User
 * doc for read paths (/raid-status, /raid-check). Runs ensureFreshWeek
 * on the seed doc in place and persists a week advance, stale roster
 * refresh or auto-manage piggyback through saveWithRetry before the
 * snapshot is returned. Centralises the toObject() unwrap + the
 * ensureFreshWeek pass so callers don't accidentally render last
 * week's progress on a stale doc.
 */

"use strict";

const {
  isAutoManageAttemptStale,
} = require("../auto-manage/runtime/support/freshness");
const {
  commitCollectedRaidViewRefresh,
} = require("./view-refresh-commit");
const { toPlainUserDoc, hasRosterAccounts } = require("../../utils/user-doc");
const { NO_SYNC_SLOT } = require("../auto-manage/runtime/support/slot");

// Whether a view load also gathers Auto Sync logs: the caller allows it, the
// user has Auto Sync on, and the last attempt is stale.
function wantsAutoManagePiggyback(seedDoc, allowAutoManage) {
  return Boolean(allowAutoManage && seedDoc.autoManageEnabled && isAutoManageAttemptStale(seedDoc));
}

/**
 * Build the view-snapshot service.
 * @param {object} deps - injected dependencies
 * @param {object} deps.User - Mongoose User model
 * @param {Function} deps.saveWithRetry - VersionError-safe save wrapper
 *   (used when ensureFreshWeek actually advances the cursor and the
 *   advance must persist)
 *   · plus ensureFreshWeek, normalizeName, getCharacterName, etc.
 *   see the destructure block.
 * @returns {object} service surface: loadFreshUserSnapshotForRaidViews
 *   and shouldLoadFreshUserSnapshotForRaidViews.
 */
function createRaidViewSnapshotService({
  User,
  saveWithRetry,
  ensureFreshWeek,
  getTargetResetKey,
  collectStaleAccountRefreshes,
  hasStaleAccountRefreshes,
  applyStaleAccountRefreshes,
  acquireAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  stampAutoManageAttempt,
  weekResetStartMs,
  log = console,
}) {
  if (!User) throw new Error("[raid-view-snapshot] User model required");
  // The function dependencies are checked in this order; the first missing one is named.
  for (const [name, dependency] of Object.entries({
    saveWithRetry, ensureFreshWeek, getTargetResetKey, hasStaleAccountRefreshes,
  })) {
    if (typeof dependency !== "function") throw new Error(`[raid-view-snapshot] ${name} required`);
  }

  async function loadFreshUserSnapshotForRaidViews(
    seedDoc,
    { allowAutoManage = true, logLabel = "[raid-status]" } = {}
  ) {
    if (!seedDoc) return null;
    const discordId = seedDoc.discordId;
    if (!discordId) return toPlainUserDoc(seedDoc);

    const hasRoster = hasRosterAccounts(seedDoc);
    const didFreshenSeedWeek = ensureFreshWeek(seedDoc);

    if (!hasRoster) {
      if (!didFreshenSeedWeek) return toPlainUserDoc(seedDoc);
      try {
        return await saveWithRetry(async () => {
          const doc = await User.findOne({ discordId });
          if (!doc) return null;
          const didFreshenWeek = ensureFreshWeek(doc);
          if (didFreshenWeek) await doc.save();
          return doc.toObject();
        });
      } catch (err) {
        log.error(`${logLabel} refresh failed for ${discordId}:`, err?.message || err);
        return await User.findOne({ discordId }).lean();
      }
    }

    let autoManageGuard = NO_SYNC_SLOT;
    try {
      let autoManagePromise = Promise.resolve(null);
      let autoManageWeekResetStart = null;
      if (wantsAutoManagePiggyback(seedDoc, allowAutoManage)) {
        autoManageGuard = await acquireAutoManageSyncSlot(discordId);
        if (autoManageGuard.acquired) {
          autoManageWeekResetStart = weekResetStartMs();
          autoManagePromise = gatherAutoManageLogsForUserDoc(
            seedDoc,
            autoManageWeekResetStart
          ).catch((err) => {
            log.warn(
              `${logLabel} auto-manage piggyback gather failed:`,
              err?.message || err
            );
            return null;
          });
        }
      }

      const [refreshCollected, autoManageCollected] = await Promise.all([
        collectStaleAccountRefreshes(seedDoc),
        autoManagePromise,
      ]);
      const autoManageBibleHit = autoManageGuard.acquired === true;
      const needsFreshWrite =
        didFreshenSeedWeek || refreshCollected.length > 0 || autoManageBibleHit;

      if (!needsFreshWrite) return toPlainUserDoc(seedDoc);

      const snapshot = await commitCollectedRaidViewRefresh({
        User,
        saveWithRetry,
        discordId,
        ensureFreshWeek,
        applyStaleAccountRefreshes,
        refreshCollected,
        applyAutoManageCollected,
        autoManageCollected,
        autoManageWeekResetStart,
        autoManageBibleHit,
      });
      return snapshot;
    } catch (err) {
      log.error(`${logLabel} refresh failed for ${discordId}:`, err?.message || err);
      if (autoManageGuard.acquired) {
        await stampAutoManageAttempt(discordId);
      }
      return await User.findOne({ discordId }).lean();
    } finally {
      autoManageGuard.release();
    }
  }

  /**
   * Whether a view must load a fresh snapshot: a known user whose week turned,
   * or whose saved roster has a stale account refresh or an Auto Sync piggyback
   * due. Each check runs only when the ones before it leave the answer open.
   * @param {object|null} seedDoc - the user document the view started from
   * @param {{allowAutoManage?: boolean}} [options] - false keeps Auto Sync out
   * @returns {boolean}
   */
  function shouldLoadFreshUserSnapshotForRaidViews(
    seedDoc,
    { allowAutoManage = true } = {}
  ) {
    if (!seedDoc?.discordId) return false;
    return seedDoc.weeklyResetKey !== getTargetResetKey()
      || (hasRosterAccounts(seedDoc)
        && (hasStaleAccountRefreshes(seedDoc) || wantsAutoManagePiggyback(seedDoc, allowAutoManage)));
  }

  return {
    loadFreshUserSnapshotForRaidViews,
    shouldLoadFreshUserSnapshotForRaidViews,
  };
}

module.exports = {
  createRaidViewSnapshotService,
};
