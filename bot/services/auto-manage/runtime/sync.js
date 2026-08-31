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

  async function commitAutoManageCollected(
    discordId,
    weekResetStart,
    collected,
    options = {}
  ) {
    return saveWithRetry(async () => {
      const doc = await User.findOne({ discordId });
      if (!doc) {
        return { status: "missing-user", report: null, snapshot: null };
      }
      if (
        options.requireRoster === true &&
        (!Array.isArray(doc.accounts) || doc.accounts.length === 0)
      ) {
        return { status: "missing-roster", report: null, snapshot: null };
      }

      ensureFreshWeek(doc);
      let report = null;
      let status = "attempt-stamped";
      const now = Date.now();

      if (collected && doc.autoManageEnabled) {
        report = applyAutoManageCollected(doc, weekResetStart, collected);
        if (stampAutoManageAttemptFromReport(doc, report, now)) {
          status = hasAppliedAutoManageDelta(report)
            ? "synced-with-delta"
            : "synced-no-delta";
        } else {
          status = "all-chars-failed";
        }
      } else {
        doc.lastAutoManageAttemptAt = now;
      }

      await doc.save();
      return {
        status,
        report,
        snapshot: toPlainUserDoc(doc),
      };
    });
  }

  async function applyAutoManageCollectedForStatus(
    discordId,
    weekResetStart,
    collected,
    logLabel
  ) {
    const result = await commitAutoManageCollected(
      discordId,
      weekResetStart,
      collected
    );
    if (!result || result.status === "missing-user") return null;
    console.log(
      `[raid-status] ${logLabel} auto-manage finished for user=${discordId} outcome=${result.status}`
    );
    return result.snapshot;
  }

  return {
    commitAutoManageCollected,
    applyAutoManageCollectedForStatus,
  };
}

module.exports = {
  createAutoManageSyncService,
};
