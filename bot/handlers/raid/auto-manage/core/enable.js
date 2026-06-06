"use strict";

const { deferEphemeralReply } = require("../../../../utils/raid/common/shared");
const { t } = require("../../../../services/i18n");

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

function setInitialSyncTitle({ embed, report, UI, lang }) {
  embed.setTitle(
    `${UI.icons.done} ${
      (report?.appliedTotal || 0) > 0
        ? t("raid-auto-manage.enable.initialSyncCompleteTitle", lang)
        : t("raid-auto-manage.enable.initialSyncNothingTitle", lang)
    }`
  );
  return embed;
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

async function awaitEnableDecision({
  interaction,
  discordId,
  ComponentType,
}) {
  const replyMsg = await interaction.fetchReply();
  try {
    const btn = await replyMsg.awaitMessageComponent({
      filter: (i) =>
        i.user.id === discordId && i.customId.startsWith("auto-manage:"),
      componentType: ComponentType.Button,
      time: 60_000,
    });
    await btn.deferUpdate().catch(() => {});
    return btn.customId === "auto-manage:confirm-on" ? "confirm" : "cancel";
  } catch {
    return "timeout";
  }
}

function buildEnableCancelEmbed({ EmbedBuilder, UI, lang, decision }) {
  const title = decision === "timeout"
    ? t("raid-auto-manage.enable.cancelTimeoutTitle", lang)
    : t("raid-auto-manage.enable.cancelTitle", lang);
  return new EmbedBuilder()
    .setColor(UI.colors.muted)
    .setTitle(`${UI.icons.reset} ${title}`)
    .setDescription(t("raid-auto-manage.enable.cancelDescription", lang))
    .setTimestamp();
}

async function enableWithoutInitialSync({ User, saveWithRetry, discordId }) {
  await saveWithRetry(async () => {
    const userDoc = await User.findOne({ discordId });
    if (!userDoc) {
      await User.findOneAndUpdate(
        { discordId },
        { $set: { autoManageEnabled: true } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      return;
    }
    userDoc.autoManageEnabled = true;
    await userDoc.save();
  });
}

function createAutoManageEnableHandler({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  UI,
  User,
  saveWithRetry,
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
    const finalReport = await commitAutoManageOn(
      discordId,
      weekResetStart,
      probeCollected
    );
    const syncEmbed = setInitialSyncTitle({
      embed: buildAutoManageSyncReportEmbed(finalReport, lang),
      report: finalReport,
      UI,
      lang,
    });
    await editAutoEmbed(syncEmbed);
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
    await deferEphemeralReply(interaction);
    try {
      if (cooldownSkip) {
        await enableWithoutInitialSync({ User, saveWithRetry, discordId });
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
      if (!probeDoc) {
        await User.findOneAndUpdate(
          { discordId },
          { $set: { autoManageEnabled: true } },
          { upsert: true, setDefaultsOnInsert: true }
        );
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

      if (!Array.isArray(probeDoc.accounts) || probeDoc.accounts.length === 0) {
        probeDoc.autoManageEnabled = true;
        await probeDoc.save();
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
      const decision = await awaitEnableDecision({
        interaction,
        discordId,
        ComponentType,
      });

      if (decision === "confirm") {
        const finalReport = await commitAutoManageOn(
          discordId,
          weekResetStart,
          probeCollected
        );
        const syncEmbed = setInitialSyncTitle({
          embed: buildAutoManageSyncReportEmbed(finalReport, lang),
          report: finalReport,
          UI,
          lang,
        });
        await editAutoEmbed(syncEmbed, { components: [] });
        return;
      }

      await stampAutoManageAttempt(discordId);
      await editAutoEmbed(
        buildEnableCancelEmbed({ EmbedBuilder, UI, lang, decision }),
        { components: [] }
      );
    } catch (err) {
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
      if (!cooldownSkip) releaseAutoManageSyncSlot(discordId);
    }
  };
}

module.exports = {
  createAutoManageEnableHandler,
  __test: {
    setInitialSyncTitle,
  },
};
