/**
 * services/raid/view-snapshot.js
 * View-snapshot service: returns a plain-object snapshot of a User
 * doc for read paths (/raid-status, /raid-check) without mutating the
 * Mongoose document. Centralises the toObject() unwrap + the
 * ensureFreshWeek pass so callers don't accidentally render last
 * week's progress on a stale doc.
 */

"use strict";

const {
  stampAutoManageAttemptFromReport,
  syncRaidProfileAfterAutoManageReport,
} = require("../auto-manage/reports/utils");
const {
  isAutoManageAttemptStale,
} = require("../auto-manage/runtime/support/freshness");

function toPlainUserSnapshot(userDoc) {
  if (!userDoc) return null;
  return typeof userDoc.toObject === "function" ? userDoc.toObject() : userDoc;
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
 * @returns {object} service surface · see the return literal for the
 *   canonical method list (computeRaidStatusSnapshot,
 *   computeRaidCheckSnapshot, etc.).
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
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  syncRaidProfileFromBibleCollected = async () => null,
  stampAutoManageAttempt,
  weekResetStartMs,
  log = console,
}) {
  if (!User) throw new Error("[raid-view-snapshot] User model required");
  if (typeof saveWithRetry !== "function") throw new Error("[raid-view-snapshot] saveWithRetry required");
  if (typeof ensureFreshWeek !== "function") throw new Error("[raid-view-snapshot] ensureFreshWeek required");
  if (typeof getTargetResetKey !== "function") throw new Error("[raid-view-snapshot] getTargetResetKey required");

  async function loadFreshUserSnapshotForRaidViews(
    seedDoc,
    { allowAutoManage = true, logLabel = "[raid-status]" } = {}
  ) {
    if (!seedDoc) return null;
    const discordId = seedDoc.discordId;
    if (!discordId) return toPlainUserSnapshot(seedDoc);

    const hasRoster = Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
    const didFreshenSeedWeek = ensureFreshWeek(seedDoc);

    if (!hasRoster) {
      if (!didFreshenSeedWeek) return toPlainUserSnapshot(seedDoc);
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

    let autoManageGuard = null;
    let profileCollected = null;
    let profileReport = null;
    let profileWeekResetStart = null;
    let shouldSyncProfile = false;
    try {
      let autoManagePromise = Promise.resolve(null);
      let autoManageWeekResetStart = null;
      if (
        allowAutoManage &&
        seedDoc.autoManageEnabled &&
        isAutoManageAttemptStale(seedDoc)
      ) {
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
      const autoManageBibleHit = autoManageGuard?.acquired === true;
      const needsFreshWrite =
        didFreshenSeedWeek || refreshCollected.length > 0 || autoManageBibleHit;

      if (!needsFreshWrite) return toPlainUserSnapshot(seedDoc);

      const snapshot = await saveWithRetry(async () => {
        const doc = await User.findOne({ discordId });
        if (!doc) return null;
        profileCollected = null;
        profileReport = null;
        profileWeekResetStart = null;
        shouldSyncProfile = false;
        const didFreshenWeek = ensureFreshWeek(doc);
        const didRefresh = applyStaleAccountRefreshes(doc, refreshCollected);

        let didAutoManage = false;
        if (autoManageCollected && doc.autoManageEnabled) {
          const autoReport = applyAutoManageCollected(
            doc,
            autoManageWeekResetStart,
            autoManageCollected
          );
          profileReport = autoReport;
          const now = Date.now();
          if (stampAutoManageAttemptFromReport(doc, autoReport, now)) {
            shouldSyncProfile = true;
            profileCollected = autoManageCollected;
            profileWeekResetStart = autoManageWeekResetStart;
          }
          didAutoManage = true;
        } else if (autoManageBibleHit) {
          doc.lastAutoManageAttemptAt = Date.now();
          didAutoManage = true;
        }

        if (didFreshenWeek || didRefresh || didAutoManage) await doc.save();
        return doc.toObject();
      });
      if (shouldSyncProfile) {
        await syncRaidProfileAfterAutoManageReport({
          syncRaidProfileFromBibleCollected,
          report: profileReport,
          discordId,
          userDoc: snapshot,
          weekResetStart: profileWeekResetStart,
          collected: profileCollected,
          logLabel: `${logLabel}:profile`,
        });
      }
      return snapshot;
    } catch (err) {
      log.error(`${logLabel} refresh failed for ${discordId}:`, err?.message || err);
      if (autoManageGuard?.acquired) {
        await stampAutoManageAttempt(discordId);
      }
      return await User.findOne({ discordId }).lean();
    } finally {
      if (autoManageGuard?.acquired) releaseAutoManageSyncSlot(discordId);
    }
  }

  function shouldLoadFreshUserSnapshotForRaidViews(
    seedDoc,
    { allowAutoManage = true } = {}
  ) {
    if (!seedDoc?.discordId) return false;
    if (seedDoc.weeklyResetKey !== getTargetResetKey()) return true;
    const hasRoster =
      Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
    if (!hasRoster) return false;
    if (
      typeof hasStaleAccountRefreshes === "function" &&
      hasStaleAccountRefreshes(seedDoc)
    ) {
      return true;
    }
    return Boolean(
      allowAutoManage &&
        seedDoc.autoManageEnabled &&
        isAutoManageAttemptStale(seedDoc)
    );
  }

  return {
    loadFreshUserSnapshotForRaidViews,
    shouldLoadFreshUserSnapshotForRaidViews,
  };
}

module.exports = {
  createRaidViewSnapshotService,
  toPlainUserSnapshot,
};
