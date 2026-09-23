"use strict";

const { deferEphemeralReply } = require("../../../../utils/raid/common/shared");
const { assertBibleSyncAllowed, enableBibleSync } = require("../../../../services/auto-manage/runtime/support/sync-mode");
const { t } = require("../../../../services/i18n");
const { awaitAutoManageDecision, buildAutoManageCancelEmbed } = require("./confirmation");

function buildEnableSimpleSuccessEmbed({ EmbedBuilder, UI, lang, descriptionKey }) {
  return new EmbedBuilder()
    .setColor(UI.colors.success)
    .setTitle(`${UI.icons.done} ${t("raid-auto-manage.enable.successTitle", lang)}`)
    .setDescription(t(descriptionKey, lang))
    .setTimestamp();
}

function buildEnableCooldownSkipEmbed({
  EmbedBuilder,
  UI,
  lang,
  guard,
  formatAutoManageCooldownRemaining,
}) {
  return new EmbedBuilder()
    .setColor(UI.colors.success)
    .setTitle(`${UI.icons.done} ${t("raid-auto-manage.enable.cooldownSkipTitle", lang)}`)
    .setDescription(
      t("raid-auto-manage.enable.cooldownSkipDescription", lang, {
        remain: formatAutoManageCooldownRemaining(guard.remainingMs),
      })
    )
    .setTimestamp();
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
  UI,
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
        type: "info",
        title: t("raid-auto-manage.enable.inFlightTitle", lang),
        description: t("raid-auto-manage.enable.inFlightDescription", lang),
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
            UI,
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
      if (!probeDoc || !Array.isArray(probeDoc.accounts) || probeDoc.accounts.length === 0) {
        await enableBibleSync(User, discordId);
        await editAutoEmbed(
          buildEnableSimpleSuccessEmbed({
            EmbedBuilder,
            UI,
            lang,
            descriptionKey: "raid-auto-manage.enable.noRosterDescription",
          })
        );
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
      const hiddenChars = (probeReport?.perChar || []).filter((charReport) =>
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
        buildAutoManageCancelEmbed({ EmbedBuilder, UI, lang, decision, action: "enable" }),
        { components: [] }
      );
    } catch (err) {
      if (!acknowledged) throw err;
      if (err?.code === "LOCAL_SYNC_ACTIVE") {
        await editAutoNotice({
          type: "warn",
          title: t("raid-auto-manage.mutex.bibleBlockedByLocalTitle", lang),
          description: t("raid-auto-manage.mutex.bibleBlockedByLocalDescription", lang),
        }, { content: null, components: [] });
        return;
      }
      await stampAutoManageAttempt(discordId);
      console.error("[auto-manage] enable-with-sync failed:", err?.message || err);
      await editAutoNotice({
        type: "error",
        title: t("raid-auto-manage.enable.probeFailTitle", lang),
        description: t("raid-auto-manage.enable.probeFailDescription", lang, {
          error: err?.message || err,
        }),
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
