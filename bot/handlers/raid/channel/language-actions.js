"use strict";

const { NoticeKind, buildNoticeEmbed } = require("../../../utils/raid/common/shared");

function createRaidChannelLanguageActions({
  EmbedBuilder,
  GuildConfig,
  getGuildLanguage,
  setGuildLanguage,
  SUPPORTED_LANGUAGES,
  t,
}) {
  function defaultLanguageEntry() {
    return SUPPORTED_LANGUAGES.find((entry) => entry.code === "vi") || SUPPORTED_LANGUAGES[0] || null;
  }

  async function currentLanguageEntry(guildId) {
    let currentEntry = defaultLanguageEntry();
    try {
      const guildLangCode = await getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
      const found = SUPPORTED_LANGUAGES.find((entry) => entry.code === guildLangCode);
      if (found) currentEntry = found;
    } catch (err) {
      console.warn("[raid-channel] guild language read failed:", err?.message || err);
    }
    return currentEntry;
  }

  async function handleSetLanguage({ interaction, guildId, lang, replyChannelEmbed, replyChannelNotice }) {
    const requested = interaction.options.getString("language", false);
    // Without the language option the reply shows the current setting and how
    // to change it: an option left out, so input.
    if (!requested) {
      const currentEntry = await currentLanguageEntry(guildId);
      await replyChannelEmbed(buildNoticeEmbed(EmbedBuilder, {
        kind: NoticeKind.INPUT,
        title: t("raid-channel-language.currentTitle", lang),
        description: t("raid-channel-language.currentDescription", lang, {
          flag: currentEntry?.flag || "",
          label: currentEntry?.label || "",
        }),
        tip: t("raid-channel-language.currentTip", lang),
      }));
      return;
    }

    const normalizedRequested = String(requested).toLowerCase();
    const langEntry = SUPPORTED_LANGUAGES.find((entry) => entry.code === normalizedRequested);
    if (!langEntry) {
      await replyChannelNotice({
        kind: NoticeKind.INPUT,
        title: t("raid-channel-language.invalidTitle", lang),
        description: t("raid-channel-language.invalidDescription", lang, { lang: requested }),
        tip: t("raid-channel-language.invalidTip", lang),
      });
      return;
    }

    await setGuildLanguage(guildId, langEntry.code, { GuildConfigModel: GuildConfig });
    const newLang = langEntry.code;
    await replyChannelEmbed(buildNoticeEmbed(EmbedBuilder, {
      kind: NoticeKind.DONE,
      title: t("raid-channel-language.successTitle", newLang),
      description: t("raid-channel-language.successDescription", newLang, {
        flag: langEntry.flag,
        label: langEntry.label,
      }),
      tip: t("raid-channel-language.successTip", newLang),
    }));
  }

  return {
    handleSetLanguage,
  };
}

module.exports = {
  createRaidChannelLanguageActions,
};
