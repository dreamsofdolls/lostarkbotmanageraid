"use strict";

const {
  NoticeKind,
  buildErrorDetailField,
  buildNoticeEmbed,
  deferEphemeralReply,
} = require("../../../../utils/raid/common/shared");
const { assertBibleSyncAllowed, enableBibleSync } = require("../../../../services/auto-manage/runtime/support/sync-mode");
const { t } = require("../../../../services/i18n");
const { getAutoManageEntries } = require("../../../../services/auto-manage/reports/utils");
const { buildAutoManageStateNotice } = require("../action-policy");
const { awaitAutoManageDecision, buildAutoManageCancelEmbed } = require("./confirmation");
const { hasRosterAccounts } = require("../../../../utils/user-doc");

function buildEnableNoRosterEmbed({ EmbedBuilder, lang }) {
  return buildNoticeEmbed(EmbedBuilder, {
    kind: NoticeKind.DONE,
    title: t("raid-auto-manage.enable.successTitle", lang),
    description: t("raid-auto-manage.enable.noRosterDescription", lang),
    tip: t("raid-auto-manage.enable.noRosterTip", lang),
  });
}

// The flag is on but the first sync waits for the cooldown.
function buildEnableCooldownSkipEmbed({
  EmbedBuilder,
  lang,
  guard,
  formatAutoManageCooldownRemaining,
}) {
  return buildNoticeEmbed(EmbedBuilder, {
    kind: NoticeKind.PARTIAL,
    title: t("raid-auto-manage.enable.cooldownSkipTitle", lang),
    description: t("raid-auto-manage.enable.cooldownSkipDescription", lang),
    fields: [{
      name: t("raid-auto-manage.fields.timeLeft", lang),
      value: formatAutoManageCooldownRemaining(guard.remainingMs),
      inline: true,
    }],
    tip: t("raid-auto-manage.enable.cooldownSkipTip", lang),
  });
}

function buildHiddenCharsConfirmRow({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  lang,
}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("auto-manage:confirm-on")
      .setLabel(t("raid-auto-manage.enable.confirmButton", lang))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("auto-manage:cancel-on")
      .setLabel(t("raid-auto-manage.enable.cancelButton", lang))
      .setStyle(ButtonStyle.Secondary)
  );
}

function createAutoManageEnableHandler({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  User,
  ensureFreshWeek,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  formatAutoManageCooldownRemaining,
  weekResetStartMs,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  isPublicLogDisabledError,
  commitAutoManageOn,
  buildAutoManageSyncReportEmbed,
  buildAutoManageHiddenCharsWarningEmbed,
  stampAutoManageAttempt,
}) {
  async function showInitialSyncReport({
    discordId,
    weekResetStart,
    probeCollected,
    lang,
    editAutoEmbed,
  }) {
    const { report, userDoc } = await commitAutoManageOn(
      discordId,
      weekResetStart,
      probeCollected
    );
    if (!userDoc) {
      // The probe read the user a moment ago. Losing the record now is an
      // error for handleOn's catch, not an empty sync.
      throw new Error("User record not found when committing auto-manage");
    }
    const syncEmbed = buildAutoManageSyncReportEmbed(report, lang, {
      userDoc,
      titleText: t(report.appliedTotal > 0
        ? "raid-auto-manage.enable.initialSyncCompleteTitle"
        : "raid-auto-manage.enable.initialSyncNothingTitle", lang),
    });
    await editAutoEmbed(syncEmbed, { components: [] });
  }

  return async function handleOn({
    interaction,
    discordId,
    lang,
    replyAutoNotice,
    editAutoNotice,
    editAutoEmbed,
  }) {
    const guard = await acquireAutoManageSyncSlot(discordId);
    if (!guard.acquired && guard.reason === "in-flight") {
      await replyAutoNotice({
        kind: NoticeKind.BUSY,
        title: t("raid-auto-manage.enable.inFlightTitle", lang),
        description: t("raid-auto-manage.enable.inFlightDescription", lang),
        tip: t("raid-auto-manage.enable.inFlightTip", lang),
      });
      return;
    }

    const cooldownSkip = !guard.acquired && guard.reason === "cooldown";
    let acknowledged = false;
    try {
      await deferEphemeralReply(interaction);
      acknowledged = true;
      if (cooldownSkip) {
        await enableBibleSync(User, discordId);
        await editAutoEmbed(
          buildEnableCooldownSkipEmbed({
            EmbedBuilder,
            lang,
            guard,
            formatAutoManageCooldownRemaining,
          })
        );
        return;
      }

      const weekResetStart = weekResetStartMs();
      const probeDoc = await User.findOne({ discordId });
      assertBibleSyncAllowed(probeDoc);
      if (!hasRosterAccounts(probeDoc)) {
        await enableBibleSync(User, discordId);
        await editAutoEmbed(buildEnableNoRosterEmbed({ EmbedBuilder, lang }));
        return;
      }

      ensureFreshWeek(probeDoc);
      const probeCollected = await gatherAutoManageLogsForUserDoc(
        probeDoc,
        weekResetStart
      );
      const probeReport = applyAutoManageCollected(
        probeDoc,
        weekResetStart,
        probeCollected
      );
      const hiddenChars = getAutoManageEntries(probeReport).filter((charReport) =>
        isPublicLogDisabledError(charReport?.error)
      );

      if (hiddenChars.length === 0) {
        await showInitialSyncReport({
          discordId,
          weekResetStart,
          probeCollected,
          lang,
          editAutoEmbed,
        });
        return;
      }

      await editAutoEmbed(
        buildAutoManageHiddenCharsWarningEmbed(hiddenChars, probeReport, lang),
        {
          components: [
            buildHiddenCharsConfirmRow({
              ActionRowBuilder,
              ButtonBuilder,
              ButtonStyle,
              lang,
            }),
          ],
        }
      );
      const decision = await awaitAutoManageDecision({
        interaction,
        discordId,
        ComponentType,
        customIdPrefix: "auto-manage:",
        confirmId: "auto-manage:confirm-on",
      });

      if (decision === "confirm") {
        await showInitialSyncReport({
          discordId,
          weekResetStart,
          probeCollected,
          lang,
          editAutoEmbed,
        });
        return;
      }

      await stampAutoManageAttempt(discordId);
      await editAutoEmbed(
        buildAutoManageCancelEmbed({ EmbedBuilder, lang, decision, action: "enable" }),
        { components: [] }
      );
    } catch (err) {
      if (!acknowledged) throw err;
      if (err?.code === "LOCAL_SYNC_ACTIVE") {
        await editAutoNotice(
          buildAutoManageStateNotice("bibleBlockedByLocal", lang),
          { content: null, components: [] },
        );
        return;
      }
      await stampAutoManageAttempt(discordId);
      console.error("[auto-manage] enable-with-sync failed:", err?.message || err);
      await editAutoNotice({
        kind: NoticeKind.FAILURE,
        title: t("raid-auto-manage.enable.probeFailTitle", lang),
        description: t("raid-auto-manage.enable.probeFailDescription", lang),
        fields: [buildErrorDetailField(err, lang)],
        tip: t("raid-auto-manage.enable.probeFailTip", lang),
      }, {
        content: null,
        components: [],
      }).catch(() => {});
    } finally {
      if (guard.acquired) releaseAutoManageSyncSlot(discordId);
    }
  };
}

module.exports = {
  createAutoManageEnableHandler,
};
