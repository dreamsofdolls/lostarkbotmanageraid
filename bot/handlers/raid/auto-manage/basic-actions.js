"use strict";

const { t } = require("../../../services/i18n");
const {
  setLocalSyncEnabled,
  getSyncStatus,
  rotateLocalSyncToken,
  extractIdentityFromUser,
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
    await User.findOneAndUpdate(
      { discordId },
      { $set: { autoManageEnabled: false } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    const embed = new EmbedBuilder()
      .setColor(UI.colors.muted)
      .setTitle(`${UI.icons.reset} ${t("raid-auto-manage.disable.title", lang)}`)
      .setDescription(t("raid-auto-manage.disable.description", lang))
      .setTimestamp();
    await replyAutoEmbed(embed);
  }

  async function handleLocalOn({ interaction, discordId, lang, replyAutoNotice, replyAutoEmbed }) {
    const result = await setLocalSyncEnabled(
      discordId,
      true,
      { force: false },
      { UserModel: User }
    );
    if (!result.ok && result.reason === SYNC_RESULT.conflict) {
      await replyAutoNotice({
        type: "warn",
        title: t("raid-auto-manage.mutex.localBlockedByBibleTitle", lang),
        description: t("raid-auto-manage.mutex.localBlockedByBibleDescription", lang),
      });
      return;
    }

    const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    let companionUrl = null;
    if (baseUrl) {
      try {
        const identity = extractIdentityFromUser(interaction.user);
        const token = await rotateLocalSyncToken(discordId, lang, { UserModel: User, identity });
        companionUrl = `${baseUrl}/sync?token=${encodeURIComponent(token)}`;
      } catch (err) {
        console.warn("[raid-auto-manage] local-on token mint failed:", err?.message || String(err));
      }
    }

    const embed = new EmbedBuilder()
      .setColor(UI.colors.success)
      .setTitle(`${UI.icons.done} ${t("raid-auto-manage.localEnable.successTitle", lang)}`)
      .setDescription(
        companionUrl
          ? t("raid-auto-manage.localEnable.successDescriptionWithLink", lang)
          : t("raid-auto-manage.localEnable.successDescription", lang)
      )
      .setTimestamp();
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
      await replyAutoNotice({
        type: "info",
        title: t("raid-auto-manage.redundant.localAlreadyOffTitle", lang),
        description: t("raid-auto-manage.redundant.localAlreadyOffDescription", lang),
      });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(UI.colors.muted)
      .setTitle(`${UI.icons.reset} ${t("raid-auto-manage.localDisable.title", lang)}`)
      .setDescription(t("raid-auto-manage.localDisable.description", lang))
      .setTimestamp();
    await replyAutoEmbed(embed);
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
