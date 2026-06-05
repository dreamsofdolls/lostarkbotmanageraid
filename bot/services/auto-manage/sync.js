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
    let shouldSyncProfile = false;
    const result = await saveWithRetry(async () => {
      const doc = await User.findOne({ discordId });
      if (!doc) return null;
      savedSnapshot = null;
      shouldSyncProfile = false;

      const didFreshenWeek = ensureFreshWeek(doc);
      let didAutoManage = false;
      let outcome = "attempt-stamped";

      if (collected && doc.autoManageEnabled) {
        const autoReport = applyAutoManageCollected(doc, weekResetStart, collected);
        const now = Date.now();
        doc.lastAutoManageAttemptAt = now;
        if (autoReport.perChar.some((c) => !c.error)) {
          doc.lastAutoManageSyncAt = now;
          shouldSyncProfile = true;
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
      savedSnapshot = typeof doc.toObject === "function" ? doc.toObject() : doc;
      console.log(
        `[raid-status] ${logLabel} auto-manage finished for user=${discordId} outcome=${outcome}`
      );
      return savedSnapshot;
    });
    if (savedSnapshot && shouldSyncProfile) {
      await syncRaidProfileFromBibleCollected({
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
