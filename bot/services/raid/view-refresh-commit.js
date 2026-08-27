"use strict";

const {
  stampAutoManageAttemptFromReport,
  toPlainUserDoc,
} = require("../auto-manage/reports/utils");

/**
 * Persist one collected raid-view refresh through the shared retry boundary.
 *
 * Both /raid-status and /raid-check collect stale roster data and optional
 * auto-manage results before entering this phase. Keeping the mutations here
 * guarantees that weekly reset, roster refresh, attempt stamps, and save rules
 * stay identical while each caller retains its own gather/timeout policy.
 */
async function commitCollectedRaidViewRefresh({
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
  onAutoManageReport = null,
}) {
  return saveWithRetry(async () => {
    const doc = await User.findOne({ discordId });
    if (!doc) return null;

    const didFreshenWeek = ensureFreshWeek(doc);
    const didRefresh = applyStaleAccountRefreshes(doc, refreshCollected);

    let didAutoManage = false;
    if (autoManageCollected && doc.autoManageEnabled) {
      const autoReport = applyAutoManageCollected(
        doc,
        autoManageWeekResetStart,
        autoManageCollected
      );
      stampAutoManageAttemptFromReport(doc, autoReport, Date.now());
      onAutoManageReport?.(autoReport);
      didAutoManage = true;
    } else if (autoManageBibleHit) {
      doc.lastAutoManageAttemptAt = Date.now();
      didAutoManage = true;
    }

    if (didFreshenWeek || didRefresh || didAutoManage) await doc.save();
    return toPlainUserDoc(doc);
  });
}

module.exports = {
  commitCollectedRaidViewRefresh,
};
