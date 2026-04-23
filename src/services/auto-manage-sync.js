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
    return await saveWithRetry(async () => {
      const doc = await User.findOne({ discordId });
      if (!doc) return null;

      const didFreshenWeek = ensureFreshWeek(doc);
      let didAutoManage = false;
      let outcome = "attempt-stamped";

      if (collected && doc.autoManageEnabled) {
        const autoReport = applyAutoManageCollected(doc, weekResetStart, collected);
        const now = Date.now();
        doc.lastAutoManageAttemptAt = now;
        if (autoReport.perChar.some((c) => !c.error)) {
          doc.lastAutoManageSyncAt = now;
          outcome = autoReport.perChar.some(
            (c) => Array.isArray(c.applied) && c.applied.length > 0
          )
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
      console.log(
        `[raid-status] ${logLabel} auto-manage finished for user=${discordId} outcome=${outcome}`
      );
      return doc.toObject();
    });
  }

  return {
    applyAutoManageCollectedForStatus,
  };
}

module.exports = {
  createAutoManageSyncService,
};
