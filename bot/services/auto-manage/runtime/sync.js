"use strict";

const {
  hasAppliedAutoManageDelta,
  stampAutoManageAttemptFromReport,
  toPlainUserDoc,
  syncRaidProfileAfterAutoManageReport,
} = require("../reports/utils");

function createAutoManageSyncService(deps) {
  const {
    User,
    saveWithRetry,
    ensureFreshWeek,
    applyAutoManageCollected,
    syncRaidProfileFromBibleCollected = async () => null,
  } = deps;

  async function applyAutoManageCollectedForStatus(
    discordId,
    weekResetStart,
    collected,
    logLabel
  ) {
    let savedSnapshot = null;
    let profileReport = null;
    let shouldSyncProfile = false;
    const result = await saveWithRetry(async () => {
      const doc = await User.findOne({ discordId });
      if (!doc) return null;
      savedSnapshot = null;
      profileReport = null;
      shouldSyncProfile = false;

      const didFreshenWeek = ensureFreshWeek(doc);
      let didAutoManage = false;
      let outcome = "attempt-stamped";

      if (collected && doc.autoManageEnabled) {
        const autoReport = applyAutoManageCollected(doc, weekResetStart, collected);
        profileReport = autoReport;
        const now = Date.now();
        if (stampAutoManageAttemptFromReport(doc, autoReport, now)) {
          shouldSyncProfile = true;
          outcome = hasAppliedAutoManageDelta(autoReport)
            ? "synced-with-delta"
            : "synced-no-delta";
        } else {
          outcome = "all-chars-failed";
        }
        didAutoManage = true;
      } else {
        doc.lastAutoManageAttemptAt = Date.now();
        didAutoManage = true;
      }

      if (didFreshenWeek || didAutoManage) await doc.save();
      savedSnapshot = toPlainUserDoc(doc);
      console.log(
        `[raid-status] ${logLabel} auto-manage finished for user=${discordId} outcome=${outcome}`
      );
      return savedSnapshot;
    });
    if (shouldSyncProfile) {
      await syncRaidProfileAfterAutoManageReport({
        syncRaidProfileFromBibleCollected,
        report: profileReport,
        discordId,
        userDoc: savedSnapshot,
        weekResetStart,
        collected,
        logLabel: `[raid-status:${logLabel || "sync"}]`,
      });
    }
    return result;
  }

  return {
    applyAutoManageCollectedForStatus,
  };
}

module.exports = {
  createAutoManageSyncService,
};
