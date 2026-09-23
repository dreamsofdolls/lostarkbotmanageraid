"use strict";

const { deferEphemeralReply } = require("../../../../utils/raid/common/shared");
const { assertBibleSyncAllowed } = require("../../../../services/auto-manage/runtime/support/sync-mode");
// tPick, not t: the cooldown intro line is a variant pool; other keys pass through.
const { tPick: t } = require("../../../../services/i18n");
const {
  stampAutoManageAttemptFromReport,
} = require("../../../../services/auto-manage/reports/utils");

function buildSyncCooldownDescription({
  lang,
  guard,
  getAutoManageCooldownMs,
  formatAutoManageCooldownRemaining,
  discordId,
}) {
  const totalCooldownText =
    typeof getAutoManageCooldownMs === "function"
      ? formatAutoManageCooldownRemaining(getAutoManageCooldownMs(discordId))
      : null;
  return [
    t("raid-auto-manage.sync.cooldownLineIntro", lang),
    "",
    t("raid-auto-manage.sync.cooldownLineWait", lang, {
      remain: formatAutoManageCooldownRemaining(guard.remainingMs),
    }),
    totalCooldownText
      ? t("raid-auto-manage.sync.cooldownLineTotal", lang, {
          totalCooldown: totalCooldownText,
        })
      : null,
    "",
    t("raid-auto-manage.sync.cooldownLineNote", lang),
  ].filter((line) => line !== null).join("\n");
}

async function replySyncGuardFailure({
  guard,
  discordId,
  lang,
  replyAutoNotice,
  getAutoManageCooldownMs,
  formatAutoManageCooldownRemaining,
}) {
  if (guard.reason === "in-flight") {
    await replyAutoNotice({
      type: "info",
      title: t("raid-auto-manage.sync.inFlightTitle", lang),
      description: t("raid-auto-manage.sync.inFlightDescription", lang),
    });
    return;
  }

  await replyAutoNotice({
    type: "info",
    title: t("raid-auto-manage.sync.cooldownTitle", lang),
    description: buildSyncCooldownDescription({
      lang,
      guard,
      getAutoManageCooldownMs,
      formatAutoManageCooldownRemaining,
      discordId,
    }),
  });
}

async function editNoRosterNotice({ lang, editAutoNotice }) {
  await editAutoNotice({
    type: "info",
    title: t("raid-auto-manage.sync.noRosterTitle", lang),
    description: t("raid-auto-manage.sync.noRosterDescription", lang),
  }, {
    content: null,
  });
}

function hasSyncableRoster(userDoc) {
  return !!userDoc && Array.isArray(userDoc.accounts) && userDoc.accounts.length > 0;
}

async function applyManualSync({
  User,
  saveWithRetry,
  ensureFreshWeek,
  applyAutoManageCollected,
  discordId,
  weekResetStart,
  collected,
}) {
  let report;
  let savedDoc = null;
  await saveWithRetry(async () => {
    const userDoc = await User.findOne({ discordId });
    assertBibleSyncAllowed(userDoc);
    if (!hasSyncableRoster(userDoc)) {
      report = { noRoster: true };
      return;
    }
    ensureFreshWeek(userDoc);
    report = applyAutoManageCollected(userDoc, weekResetStart, collected);
    stampAutoManageAttemptFromReport(userDoc, report, Date.now());
    await userDoc.save();
    // Set after the save, so a failed attempt that saveWithRetry repeats
    // never leaves its document behind.
    savedDoc = userDoc;
  });
  return { report, userDoc: savedDoc };
}

function createAutoManageSyncHandler({
  User,
  saveWithRetry,
  ensureFreshWeek,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  formatAutoManageCooldownRemaining,
  getAutoManageCooldownMs,
  weekResetStartMs,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  buildAutoManageSyncReportEmbed,
}) {
  return async function handleSync({
    interaction,
    discordId,
    lang,
    replyAutoNotice,
    editAutoNotice,
    editAutoEmbed,
  }) {
    const guard = await acquireAutoManageSyncSlot(discordId);
    if (!guard.acquired) {
      await replySyncGuardFailure({
        guard,
        discordId,
        lang,
        replyAutoNotice,
        getAutoManageCooldownMs,
        formatAutoManageCooldownRemaining,
      });
      return;
    }

    let acknowledged = false;
    try {
      await deferEphemeralReply(interaction);
      acknowledged = true;
      const weekResetStart = weekResetStartMs();
      const seedDoc = await User.findOne({ discordId });
      assertBibleSyncAllowed(seedDoc);
      if (!hasSyncableRoster(seedDoc)) {
        await editNoRosterNotice({ lang, editAutoNotice });
        return;
      }

      ensureFreshWeek(seedDoc);
      const collected = await gatherAutoManageLogsForUserDoc(
        seedDoc,
        weekResetStart
      );
      const { report, userDoc } = await applyManualSync({
        User,
        saveWithRetry,
        ensureFreshWeek,
        applyAutoManageCollected,
        discordId,
        weekResetStart,
        collected,
      });

      if (report?.noRoster) {
        await editNoRosterNotice({ lang, editAutoNotice });
        return;
      }

      await editAutoEmbed(buildAutoManageSyncReportEmbed(report, lang, { userDoc }));
    } catch (err) {
      if (!acknowledged) throw err;
      if (err?.code === "LOCAL_SYNC_ACTIVE") {
        await editAutoNotice({
          type: "warn",
          title: t("raid-auto-manage.sync.localLockedTitle", lang),
          description: t("raid-auto-manage.sync.localLockedDescription", lang),
        }, { content: null });
        return;
      }
      console.error("[auto-manage] sync failed:", err?.message || err);
      await editAutoNotice({
        type: "error",
        title: t("raid-auto-manage.sync.failTitle", lang),
        description: t("raid-auto-manage.sync.failDescription", lang, {
          error: err?.message || err,
        }),
      }, {
        content: null,
      });
    } finally {
      releaseAutoManageSyncSlot(discordId);
    }
  };
}

module.exports = {
  createAutoManageSyncHandler,
};
