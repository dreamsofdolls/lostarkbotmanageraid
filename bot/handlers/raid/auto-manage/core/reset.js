"use strict";

const { RAID_ORDER } = require("../../../../domain/raid-catalog");
const { t } = require("../../../../services/i18n");
const {
  NoticeKind,
  buildErrorDetailField,
  buildNoticeEmbed,
} = require("../../../../utils/raid/common/shared");
const { resetAutoManageDailyState } = require("../../../../services/auto-manage/runtime/support/daily-state");
const { awaitAutoManageDecision, buildAutoManageCancelEmbed } = require("./confirmation");
const { NO_SYNC_SLOT } = require("../../../../services/auto-manage/runtime/support/slot");

// A confirm card; the irreversible step is carried by the red Danger button.
function buildResetConfirmEmbed({ EmbedBuilder, lang }) {
  return buildNoticeEmbed(EmbedBuilder, {
    kind: NoticeKind.CONFIRM,
    title: t("raid-auto-manage.reset.confirmTitle", lang),
    description: t("raid-auto-manage.reset.confirmDescription", lang),
    fields: [{
      name: t("raid-auto-manage.reset.confirmKeptLabel", lang),
      value: t("raid-auto-manage.reset.confirmKeptValue", lang),
      inline: false,
    }],
    tip: t("raid-auto-manage.reset.confirmTip", lang),
  });
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

function buildResetSuccessEmbed({ EmbedBuilder, lang }) {
  return buildNoticeEmbed(EmbedBuilder, {
    kind: NoticeKind.DONE,
    title: t("raid-auto-manage.reset.successTitle", lang),
    description: t("raid-auto-manage.reset.successDescription", lang),
    tip: t("raid-auto-manage.reset.successTip", lang),
  });
}

function wipeAutoManageState(userDoc) {
  resetAutoManageDailyState(userDoc);
  userDoc.autoManageEnabled = false;
  userDoc.localSyncEnabled = false;
  userDoc.localSyncLinkedAt = null;
  userDoc.lastAutoManageSyncAt = null;
  userDoc.lastAutoManageAttemptAt = null;
  userDoc.lastLocalSyncAt = null;
  userDoc.lastLocalSyncToken = null;
  userDoc.lastLocalSyncTokenExpAt = null;
  for (const account of userDoc.accounts || []) {
    account.lastRefreshedAt = null;
    account.lastRefreshAttemptAt = null;
    for (const character of account.characters || []) {
      character.assignedRaids = Object.fromEntries(
        RAID_ORDER.map((raidKey) => [raidKey, {}])
      );
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
  User,
  saveWithRetry,
  acquireAutoManageSyncSlot,
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
      buildResetConfirmEmbed({ EmbedBuilder, lang }),
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

    const decision = await awaitAutoManageDecision({
      interaction,
      discordId,
      ComponentType,
      customIdPrefix: "auto-manage:reset-",
      confirmId: "auto-manage:reset-confirm",
    });
    if (decision !== "confirm") {
      await editAutoEmbed(
        buildAutoManageCancelEmbed({ EmbedBuilder, lang, decision, action: "reset" }),
        { components: [] }
      ).catch(() => {});
      return;
    }

    let resetGuard = NO_SYNC_SLOT;
    try {
      resetGuard = await acquireAutoManageSyncSlot(discordId, {
        ignoreCooldown: true,
      });
      if (!resetGuard.acquired) {
        await editAutoNotice({
          kind: NoticeKind.BUSY,
          title: t("raid-auto-manage.reset.inFlightTitle", lang),
          description: t("raid-auto-manage.reset.inFlightDescription", lang),
          tip: t("raid-auto-manage.reset.inFlightTip", lang),
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
        kind: NoticeKind.FAILURE,
        title: t("raid-auto-manage.reset.failTitle", lang),
        description: t("raid-auto-manage.reset.failDescription", lang),
        fields: [buildErrorDetailField(err, lang)],
        tip: t("raid-auto-manage.reset.failTip", lang),
      }, {
        components: [],
      }).catch(() => {});
      return;
    } finally {
      resetGuard.release();
    }

    await editAutoEmbed(
      buildResetSuccessEmbed({ EmbedBuilder, lang }),
      { components: [] }
    ).catch(() => {});
  };
}

module.exports = {
  createAutoManageResetHandler,
};
