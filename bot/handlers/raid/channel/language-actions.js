"use strict";

function createRaidChannelLanguageActions({
  EmbedBuilder,
  UI,
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
    if (!requested) {
      const currentEntry = await currentLanguageEntry(guildId);
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`${UI.icons.info} ${t("raid-channel-language.currentTitle", lang)}`)
        .setDescription(
          t("raid-channel-language.currentDescription", lang, {
            flag: currentEntry?.flag || "",
            label: currentEntry?.label || "",
          })
        );
      await replyChannelEmbed(embed);
      return;
    }

    const normalizedRequested = String(requested).toLowerCase();
    const langEntry = SUPPORTED_LANGUAGES.find((entry) => entry.code === normalizedRequested);
    if (!langEntry) {
      await replyChannelNotice({
        type: "warn",
        title: t("raid-channel-language.invalidTitle", lang),
        description: t("raid-channel-language.invalidDescription", lang, { lang: requested }),
      });
      return;
    }

    await setGuildLanguage(guildId, langEntry.code, { GuildConfigModel: GuildConfig });
    const newLang = langEntry.code;
    const embed = new EmbedBuilder()
      .setColor(UI.colors.success)
      .setTitle(`${UI.icons.done} ${t("raid-channel-language.successTitle", newLang)}`)
      .setDescription(
        t("raid-channel-language.successDescription", newLang, {
          flag: langEntry.flag,
          label: langEntry.label,
        })
      )
      .setTimestamp();
    await replyChannelEmbed(embed);
  }

  return {
    handleSetLanguage,
  };
}

module.exports = {
  createRaidChannelLanguageActions,
};
