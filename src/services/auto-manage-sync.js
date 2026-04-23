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

      if (collected && doc.autoManageEnabled) {
        const autoReport = applyAutoManageCollected(doc, weekResetStart, collected);
        const now = Date.now();
        doc.lastAutoManageAttemptAt = now;
        if (autoReport.perChar.some((c) => !c.error)) {
          doc.lastAutoManageSyncAt = now;
        }
        didAutoManage = true;
      } else {
        doc.lastAutoManageAttemptAt = Date.now();
        didAutoManage = true;
      }

      if (didFreshenWeek || didAutoManage) await doc.save();
      console.log(`[raid-status] ${logLabel} auto-manage applied for user=${discordId}`);
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
