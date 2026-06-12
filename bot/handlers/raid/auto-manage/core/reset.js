"use strict";

const { t } = require("../../../../services/i18n");

function buildResetConfirmEmbed({ EmbedBuilder, UI, lang }) {
  return new EmbedBuilder()
    .setColor(UI.colors.error || 0xff5555)
    .setTitle(`${UI.icons.warn} ${t("raid-auto-manage.reset.confirmTitle", lang)}`)
    .setDescription(t("raid-auto-manage.reset.confirmDescription", lang))
    .setTimestamp();
}

function buildResetConfirmRow({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  lang,
}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("auto-manage:reset-confirm")
      .setLabel(t("raid-auto-manage.reset.confirmButton", lang))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("auto-manage:reset-cancel")
      .setLabel(t("raid-auto-manage.reset.cancelButton", lang))
      .setStyle(ButtonStyle.Secondary)
  );
}

async function awaitResetDecision({
  interaction,
  discordId,
  ComponentType,
}) {
  const replyMsg = await interaction.fetchReply();
  try {
    const btn = await replyMsg.awaitMessageComponent({
      filter: (i) =>
        i.user.id === discordId && i.customId.startsWith("auto-manage:reset-"),
      componentType: ComponentType.Button,
      time: 60_000,
    });
    await btn.deferUpdate().catch(() => {});
    return btn.customId === "auto-manage:reset-confirm" ? "confirm" : "cancel";
  } catch {
    return "timeout";
  }
}

function buildResetCancelEmbed({ EmbedBuilder, UI, lang, decision }) {
  const title = decision === "timeout"
    ? t("raid-auto-manage.reset.cancelTimeoutTitle", lang)
    : t("raid-auto-manage.reset.cancelTitle", lang);
  return new EmbedBuilder()
    .setColor(UI.colors.muted)
    .setTitle(`${UI.icons.reset} ${title}`)
    .setDescription(t("raid-auto-manage.reset.cancelDescription", lang))
    .setTimestamp();
}

function buildResetSuccessEmbed({ EmbedBuilder, UI, lang }) {
  return new EmbedBuilder()
    .setColor(UI.colors.success)
    .setTitle(`${UI.icons.done} ${t("raid-auto-manage.reset.successTitle", lang)}`)
    .setDescription(t("raid-auto-manage.reset.successDescription", lang))
    .setTimestamp();
}

function wipeAutoManageState(userDoc) {
  userDoc.autoManageEnabled = false;
  userDoc.localSyncEnabled = false;
  userDoc.localSyncLinkedAt = null;
  userDoc.lastAutoManageSyncAt = null;
  userDoc.lastAutoManageAttemptAt = null;
  userDoc.lastLocalSyncAt = null;
  userDoc.lastLocalSyncToken = null;
  userDoc.lastLocalSyncTokenExpAt = null;
  userDoc.lastPrivateLogNudgeAt = null;
  for (const account of userDoc.accounts || []) {
    account.lastRefreshedAt = null;
    account.lastRefreshAttemptAt = null;
    for (const character of account.characters || []) {
      character.assignedRaids = { armoche: {}, kazeros: {}, serca: {}, horizon: {} };
      character.publicLogDisabled = false;
      character.publicLogDisabledAt = null;
      character.bibleSerial = null;
      character.bibleCid = null;
      character.bibleRid = null;
    }
  }
}

function createAutoManageResetHandler({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  UI,
  User,
  saveWithRetry,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
}) {
  return async function handleReset({
    interaction,
    discordId,
    lang,
    replyAutoEmbed,
    editAutoNotice,
    editAutoEmbed,
  }) {
    await replyAutoEmbed(
      buildResetConfirmEmbed({ EmbedBuilder, UI, lang }),
      {
        components: [
          buildResetConfirmRow({
            ActionRowBuilder,
            ButtonBuilder,
            ButtonStyle,
            lang,
          }),
        ],
      }
    );

    const decision = await awaitResetDecision({
      interaction,
      discordId,
      ComponentType,
    });
    if (decision !== "confirm") {
      await editAutoEmbed(
        buildResetCancelEmbed({ EmbedBuilder, UI, lang, decision }),
        { components: [] }
      ).catch(() => {});
      return;
    }

    let resetGuard = null;
    try {
      resetGuard = await acquireAutoManageSyncSlot(discordId, {
        ignoreCooldown: true,
      });
      if (!resetGuard.acquired) {
        await editAutoNotice({
          type: "info",
          title: t("raid-auto-manage.reset.inFlightTitle", lang),
          description: t("raid-auto-manage.reset.inFlightDescription", lang),
        }, {
          components: [],
        }).catch(() => {});
        return;
      }

      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId });
        if (!userDoc) return;
        wipeAutoManageState(userDoc);
        await userDoc.save();
      });
    } catch (err) {
      console.error("[raid-auto-manage] reset failed:", err?.message || err);
      await editAutoNotice({
        type: "error",
        title: t("raid-auto-manage.reset.failTitle", lang),
        description: t("raid-auto-manage.reset.failDescription", lang, {
          error: err?.message || String(err),
        }),
      }, {
        components: [],
      }).catch(() => {});
      return;
    } finally {
      if (resetGuard?.acquired) releaseAutoManageSyncSlot(discordId);
    }

    await editAutoEmbed(
      buildResetSuccessEmbed({ EmbedBuilder, UI, lang }),
      { components: [] }
    ).catch(() => {});
  };
}

module.exports = {
  createAutoManageResetHandler,
  __test: {
    wipeAutoManageState,
  },
};
