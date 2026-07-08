"use strict";

const {
  hasAppliedAutoManageDelta,
  stampAutoManageAttemptFromReport,
  toPlainUserDoc,
} = require("../reports/utils");

function createAutoManageSyncService(deps) {
  const {
    User,
    saveWithRetry,
    ensureFreshWeek,
    applyAutoManageCollected,
  } = deps;

  async function applyAutoManageCollectedForStatus(
    discordId,
    weekResetStart,
    collected,
    logLabel
  ) {
    let savedSnapshot = null;
    const result = await saveWithRetry(async () => {
      const doc = await User.findOne({ discordId });
      if (!doc) return null;
      savedSnapshot = null;

      const didFreshenWeek = ensureFreshWeek(doc);
      let didAutoManage = false;
      let outcome = "attempt-stamped";

      if (collected && doc.autoManageEnabled) {
        const autoReport = applyAutoManageCollected(doc, weekResetStart, collected);
        const now = Date.now();
        if (stampAutoManageAttemptFromReport(doc, autoReport, now)) {
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
    return result;
  }

  return {
    applyAutoManageCollectedForStatus,
  };
}

module.exports = {
  createAutoManageSyncService,
};
