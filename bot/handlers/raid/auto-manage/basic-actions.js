"use strict";

const { t } = require("../../../services/i18n");
const { NoticeKind, buildNoticeEmbed } = require("../../../utils/raid/common/shared");
const { buildAutoManageStateNotice } = require("./action-policy");
const {
  setBibleAutoSyncEnabled,
  setLocalSyncEnabled,
  getSyncStatus,
  issueLocalSyncAccessUrl,
  RESULT: SYNC_RESULT,
} = require("../../../services/local-sync");

function createAutoManageBasicActionHandlers({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  User,
}) {
  async function handleOff({ discordId, lang, replyAutoEmbed }) {
    await setBibleAutoSyncEnabled(discordId, false, {}, { UserModel: User });
    await replyAutoEmbed(buildNoticeEmbed(EmbedBuilder, {
      kind: NoticeKind.DONE,
      title: t("raid-auto-manage.disable.title", lang),
      description: t("raid-auto-manage.disable.description", lang),
      tip: t("raid-auto-manage.disable.tip", lang),
    }));
  }

  async function handleLocalOn({ interaction, discordId, lang, replyAutoNotice, replyAutoEmbed }) {
    const result = await setLocalSyncEnabled(
      discordId,
      true,
      { force: false },
      { UserModel: User }
    );
    if (!result.ok && result.reason === SYNC_RESULT.conflict) {
      await replyAutoNotice(buildAutoManageStateNotice("localBlockedByBible", lang));
      return;
    }

    let companionUrl = null;
    try {
      companionUrl = await issueLocalSyncAccessUrl({
        discordId,
        lang,
        UserModel: User,
        discordUser: interaction.user,
      });
    } catch (err) {
      console.warn("[raid-auto-manage] local-on token mint failed:", err?.message || String(err));
    }

    // Local-sync is on either way; without a Reader link the card says what
    // is still missing.
    const embed = buildNoticeEmbed(EmbedBuilder, companionUrl
      ? {
        kind: NoticeKind.DONE,
        title: t("raid-auto-manage.localEnable.successTitle", lang),
        description: t("raid-auto-manage.localEnable.successDescriptionWithLink", lang),
        tip: t("raid-auto-manage.localEnable.successTip", lang),
      }
      : {
        kind: NoticeKind.PARTIAL,
        title: t("raid-auto-manage.localEnable.successTitle", lang),
        description: t("raid-auto-manage.localEnable.successDescription", lang),
        tip: t("raid-auto-manage.localEnable.successNoLinkTip", lang),
      });
    const replyExtras = {};
    if (companionUrl) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(t("raid-auto-manage.localEnable.openButtonLabel", lang))
          .setURL(companionUrl)
      );
      replyExtras.components = [row];
    }
    await replyAutoEmbed(embed, replyExtras);
  }

  async function handleLocalOff({ discordId, lang, replyAutoNotice, replyAutoEmbed }) {
    const result = await setLocalSyncEnabled(
      discordId,
      false,
      {},
      { UserModel: User }
    );
    if (!result.ok && result.reason === SYNC_RESULT.noUser) {
      await replyAutoNotice(buildAutoManageStateNotice("localAlreadyOff", lang));
      return;
    }
    await replyAutoEmbed(buildNoticeEmbed(EmbedBuilder, {
      kind: NoticeKind.DONE,
      title: t("raid-auto-manage.localDisable.title", lang),
      description: t("raid-auto-manage.localDisable.description", lang),
      tip: t("raid-auto-manage.localDisable.tip", lang),
    }));
  }

  async function handleStatus({ discordId, lang, replyAutoEmbed }) {
    const status = await getSyncStatus(discordId, { UserModel: User });
    const bibleOptInValue = status.bible.enabled
      ? `${UI.icons.done} ${t("raid-auto-manage.status.optInOn", lang)}`
      : `${UI.icons.reset} ${t("raid-auto-manage.status.optInOff", lang)}`;
    const bibleLastSync = status.bible.lastSyncAt || 0;
    const bibleLastAttempt = status.bible.lastAttemptAt || 0;
    const bibleLastSuccessValue = bibleLastSync
      ? `<t:${Math.floor(bibleLastSync / 1000)}:R>`
      : t("raid-auto-manage.status.lastSuccessNever", lang);
    let bibleLastAttemptValue;
    if (!bibleLastAttempt) {
      bibleLastAttemptValue = t("raid-auto-manage.status.lastAttemptNever", lang);
    } else if (bibleLastAttempt === bibleLastSync) {
      bibleLastAttemptValue = t("raid-auto-manage.status.lastAttemptSameAsSuccess", lang);
    } else {
      bibleLastAttemptValue = `<t:${Math.floor(bibleLastAttempt / 1000)}:R> - ${t(
        "raid-auto-manage.status.lastAttemptFailSuffix",
        lang,
      )}`;
    }

    const localOptInValue = status.local.enabled
      ? `${UI.icons.done} ${t("raid-auto-manage.status.localOptInOn", lang)}`
      : `${UI.icons.reset} ${t("raid-auto-manage.status.localOptInOff", lang)}`;
    const localLastSync = status.local.lastSyncAt || 0;
    const localLastSyncValue = localLastSync
      ? `<t:${Math.floor(localLastSync / 1000)}:R>`
      : t("raid-auto-manage.status.lastSuccessNever", lang);
    const embed = new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(`${UI.icons.info} ${t("raid-auto-manage.status.title", lang)}`)
      .addFields(
        { name: t("raid-auto-manage.status.optInLabel", lang), value: bibleOptInValue, inline: true },
        {
          name: t("raid-auto-manage.status.lastSuccessLabel", lang),
          value: bibleLastSuccessValue,
          inline: true,
        },
        {
          name: t("raid-auto-manage.status.lastAttemptLabel", lang),
          value: bibleLastAttemptValue,
          inline: true,
        },
        { name: t("raid-auto-manage.status.localOptInLabel", lang), value: localOptInValue, inline: true },
        {
          name: t("raid-auto-manage.status.localLastSyncLabel", lang),
          value: localLastSyncValue,
          inline: true,
        },
        { name: "\u200b", value: "\u200b", inline: true }
      )
      .setTimestamp();
    await replyAutoEmbed(embed);
  }

  return {
    off: handleOff,
    "local-on": handleLocalOn,
    "local-off": handleLocalOff,
    status: handleStatus,
  };
}

module.exports = {
  createAutoManageBasicActionHandlers,
};
