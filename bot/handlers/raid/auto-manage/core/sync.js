"use strict";

const {
  NoticeKind,
  buildDetailField,
  buildNoRosterNotice,
  deferEphemeralReply,
} = require("../../../../utils/raid/common/shared");
const { assertBibleSyncAllowed } = require("../../../../services/auto-manage/runtime/support/sync-mode");
// tPick, not t: the cooldown intro line is a variant pool; other keys pass through.
const { tPick: t } = require("../../../../services/i18n");
const {
  stampAutoManageAttemptFromReport,
} = require("../../../../services/auto-manage/reports/utils");
const { buildAutoManageStateNotice } = require("../action-policy");

function buildSyncCooldownNotice({
  lang,
  guard,
  getAutoManageCooldownMs,
  formatAutoManageCooldownRemaining,
  discordId,
}) {
  const totalCooldownText =
    formatAutoManageCooldownRemaining(getAutoManageCooldownMs(discordId));
  return {
    kind: NoticeKind.BUSY,
    title: t("raid-auto-manage.sync.cooldownTitle", lang),
    description: t("raid-auto-manage.sync.cooldownLineIntro", lang),
    fields: [
      {
        name: t("raid-auto-manage.fields.timeLeft", lang),
        value: formatAutoManageCooldownRemaining(guard.remainingMs),
        inline: true,
      },
      totalCooldownText
        ? { name: t("raid-auto-manage.sync.cooldownTotalLabel", lang), value: totalCooldownText, inline: true }
        : null,
    ],
    tip: t("raid-auto-manage.sync.cooldownTip", lang),
  };
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
      kind: NoticeKind.BUSY,
      title: t("raid-auto-manage.sync.inFlightTitle", lang),
      description: t("raid-auto-manage.sync.inFlightDescription", lang),
      tip: t("raid-auto-manage.sync.inFlightTip", lang),
    });
    return;
  }

  await replyAutoNotice(buildSyncCooldownNotice({
    lang,
    guard,
    getAutoManageCooldownMs,
    formatAutoManageCooldownRemaining,
    discordId,
  }));
}

async function editNoRosterNotice({ lang, editAutoNotice }) {
  await editAutoNotice(buildNoRosterNotice(lang), { content: null });
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
        await editAutoNotice(buildAutoManageStateNotice("localLocked", lang), { content: null });
        return;
      }
      console.error("[auto-manage] sync failed:", err?.message || err);
      await editAutoNotice({
        kind: NoticeKind.FAILURE,
        title: t("raid-auto-manage.sync.failTitle", lang),
        description: t("raid-auto-manage.sync.failDescription", lang),
        fields: [buildDetailField(err?.message || String(err), lang)],
        tip: t("raid-auto-manage.sync.failTip", lang),
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
