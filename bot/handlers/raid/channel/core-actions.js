"use strict";

const { deferEphemeralReply } = require("../../../utils/raid/common/shared");

const RAID_CHANNEL_GREETING_TTL_MS = 2 * 60 * 1000;

function createRaidChannelCoreActions({
  EmbedBuilder,
  UI,
  GuildConfig,
  getCachedMonitorChannelId,
  setCachedMonitorChannelId,
  getMonitorCacheHealth,
  isTextMonitorEnabled,
  getMissingBotChannelPermissions,
  postRaidChannelWelcome,
  postChannelAnnouncement,
  getAnnouncementsConfig,
  resolveRaidMonitorChannel,
  cleanupRaidChannelMessages,
  getGuildLanguage,
  SUPPORTED_LANGUAGES,
  t,
}) {
  async function loadBroadcastLanguageLine(guildId, lang) {
    try {
      const guildLangCode = await getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
      const langEntry =
        SUPPORTED_LANGUAGES.find((l) => l.code === guildLangCode) ||
        SUPPORTED_LANGUAGES.find((l) => l.code === "vi");
      if (!langEntry) return null;
      return t("raid-channel-language.showCurrentLine", lang, {
        flag: langEntry.flag,
        label: langEntry.label,
      });
    } catch (err) {
      console.warn("[raid-channel] guild language read failed:", err?.message || err);
      return null;
    }
  }

  function buildDeployNotes(lang) {
    const notes = [];
    if (!isTextMonitorEnabled()) {
      notes.push(t("raid-channel.show.monitorDisabledNote", lang, { icon: UI.icons.warn }));
    }

    const { healthy, error } = getMonitorCacheHealth();
    if (!healthy) {
      const errorSuffix = error
        ? t("raid-channel.show.cacheUnhealthyErrorSuffix", lang, { error })
        : "";
      notes.push(t("raid-channel.show.cacheUnhealthyNote", lang, {
        icon: UI.icons.warn,
        errorSuffix,
      }));
    }
    return notes;
  }

  async function resolveConfiguredChannel(interaction, channelId) {
    let channel = interaction.guild?.channels?.cache?.get(channelId) || null;
    if (!channel && interaction.guild?.channels?.fetch) {
      try {
        channel = await interaction.guild.channels.fetch(channelId);
      } catch {
        channel = null;
      }
    }
    return channel;
  }

  async function loadSetGreetingEnabled(guildId) {
    try {
      const existingCfg = await GuildConfig.findOne({ guildId })
        .select("announcements.setGreeting")
        .lean();
      return getAnnouncementsConfig(existingCfg).setGreeting.enabled;
    } catch {
      return true;
    }
  }

  async function postSetGreetingIfEnabled({ channel, guildId, guildLang }) {
    const greetingEnabled = await loadSetGreetingEnabled(guildId);
    if (!greetingEnabled) return;

    await postChannelAnnouncement(
      channel,
      t("raid-channel.set.greetingMessage", guildLang),
      RAID_CHANNEL_GREETING_TTL_MS,
      "raid-channel set greeting"
    );
  }

  async function handleSetChannel({ interaction, guildId, lang, replyChannelEmbed, replyChannelNotice }) {
    const channel = interaction.options.getChannel("channel");
    if (!channel) {
      await replyChannelNotice({
        type: "warn",
        title: t("raid-channel.set.missingChannelTitle", lang),
        description: t("raid-channel.set.missingChannelDescription", lang),
      });
      return;
    }

    if (!isTextMonitorEnabled()) {
      await replyChannelNotice({
        type: "lock",
        title: t("raid-channel.set.monitorDisabledTitle", lang),
        description: t("raid-channel.set.monitorDisabledDescription", lang),
      });
      return;
    }

    const botMember = interaction.guild?.members?.me;
    const missing = getMissingBotChannelPermissions(channel, botMember);
    if (missing.length > 0) {
      await replyChannelNotice({
        type: "lock",
        title: t("raid-channel.set.missingPermsTitle", lang),
        description: t("raid-channel.set.missingPermsDescription", lang, {
          channelId: channel.id,
          missing: missing.join(", "),
        }),
      });
      return;
    }

    await GuildConfig.findOneAndUpdate(
      { guildId },
      { guildId, raidChannelId: channel.id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    setCachedMonitorChannelId(guildId, channel.id);

    const welcome = await postRaidChannelWelcome(channel, interaction.client.user.id, guildId);
    if (welcome.posted) {
      const guildLang = await getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
      await postSetGreetingIfEnabled({ channel, guildId, guildLang });
    }

    const welcomeIcon = welcome.posted ? UI.icons.done : UI.icons.warn;
    const welcomeKey = welcome.posted
      ? welcome.pinned
        ? "welcomeValuePostedPinned"
        : "welcomeValuePostedNoPin"
      : "welcomeValueNotPosted";
    const embed = new EmbedBuilder()
      .setColor(UI.colors.success)
      .setTitle(`${UI.icons.done} ${t("raid-channel.set.successTitle", lang)}`)
      .setDescription(t("raid-channel.set.successDescription", lang, { channelId: channel.id }))
      .addFields(
        {
          name: t("raid-channel.set.examplesField", lang),
          value: t("raid-channel.set.examplesValue", lang),
        },
        {
          name: t("raid-channel.set.welcomeField", lang),
          value: t(`raid-channel.set.${welcomeKey}`, lang, {
            icon: welcomeIcon,
            channelId: channel.id,
          }),
        },
        {
          name: t("raid-channel.set.changeChannelField", lang),
          value: t("raid-channel.set.changeChannelValue", lang),
        },
      )
      .setTimestamp();
    await replyChannelEmbed(embed);
  }

  async function handleShowChannel({ interaction, guildId, lang, replyChannelEmbed }) {
    const channelId = getCachedMonitorChannelId(guildId);
    const embed = new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(`${UI.icons.info} ${t("raid-channel.show.title", lang)}`);
    const deployNotes = buildDeployNotes(lang);
    const broadcastLangLine = await loadBroadcastLanguageLine(guildId, lang);

    if (!channelId) {
      const lines = [t("raid-channel.show.noConfigLine", lang)];
      if (broadcastLangLine) lines.push("", broadcastLangLine);
      if (deployNotes.length > 0) lines.push("", ...deployNotes);
      embed.setDescription(lines.join("\n"));
      await replyChannelEmbed(embed);
      return;
    }

    const channel = await resolveConfiguredChannel(interaction, channelId);
    const botMember = interaction.guild?.members?.me;
    const missing = channel ? getMissingBotChannelPermissions(channel, botMember) : null;
    const lines = [t("raid-channel.show.monitoringLine", lang, { channelId })];
    if (!channel) {
      lines.push(t("raid-channel.show.channelInaccessibleLine", lang, { icon: UI.icons.warn }));
    } else if (missing && missing.length > 0) {
      lines.push(t("raid-channel.show.channelMissingPermsLine", lang, {
        icon: UI.icons.warn,
        missing: missing.join(", "),
      }));
    } else {
      lines.push(t("raid-channel.show.channelOkLine", lang, { icon: UI.icons.done }));
    }
    if (broadcastLangLine) lines.push("", broadcastLangLine);
    if (deployNotes.length > 0) lines.push("", ...deployNotes);
    embed.setDescription(lines.join("\n"));
    await replyChannelEmbed(embed);
  }

  async function handleClearChannel({ guildId, lang, replyChannelEmbed }) {
    await GuildConfig.findOneAndUpdate(
      { guildId },
      { $set: { raidChannelId: null, autoCleanupEnabled: false } }
    );
    setCachedMonitorChannelId(guildId, null);
    const embed = new EmbedBuilder()
      .setColor(UI.colors.muted)
      .setTitle(`${UI.icons.reset} ${t("raid-channel.clear.title", lang)}`)
      .setDescription(t("raid-channel.clear.description", lang));
    await replyChannelEmbed(embed);
  }

  async function resolveMonitorChannelForAction({ interaction, guildId, lang, replyChannelNotice }) {
    const channelId = getCachedMonitorChannelId(guildId);
    if (!channelId) {
      await replyChannelNotice({
        type: "warn",
        title: t("raid-channel.cleanup.noConfigTitle", lang),
        description: t("raid-channel.cleanup.noConfigDescription", lang),
      });
      return null;
    }

    const channel = await resolveRaidMonitorChannel(interaction, channelId);
    if (!channel) {
      await replyChannelNotice({
        type: "warn",
        title: t("raid-channel.cleanup.channelGoneTitle", lang),
        description: t("raid-channel.cleanup.channelGoneDescription", lang, { channelId }),
      });
      return null;
    }
    return channel;
  }

  async function handleCleanupChannel({
    interaction,
    guildId,
    lang,
    replyChannelNotice,
    editChannelEmbed,
    editChannelNotice,
  }) {
    const channel = await resolveMonitorChannelForAction({
      interaction,
      guildId,
      lang,
      replyChannelNotice,
    });
    if (!channel) return;

    await deferEphemeralReply(interaction);
    try {
      const { deleted, skippedOld } = await cleanupRaidChannelMessages(channel);
      const embed = new EmbedBuilder()
        .setColor(UI.colors.success)
        .setTitle(`${UI.icons.done} ${t("raid-channel.cleanup.successTitle", lang)}`)
        .setDescription(t("raid-channel.cleanup.successDescription", lang, { channelId: channel.id }))
        .addFields({
          name: t("raid-channel.cleanup.deletedField", lang),
          value: t("raid-channel.cleanup.deletedValue", lang, { count: deleted }),
          inline: true,
        })
        .setTimestamp();
      if (skippedOld > 0) {
        embed.addFields({
          name: t("raid-channel.cleanup.skippedField", lang),
          value: `${skippedOld}`,
          inline: true,
        });
      }
      await editChannelEmbed(embed);
    } catch (err) {
      console.error("[raid-channel] manual cleanup failed:", err?.message || err);
      await editChannelNotice({
        type: "error",
        title: t("raid-channel.cleanup.failTitle", lang),
        description: t("raid-channel.cleanup.failDescription", lang, {
          error: err?.message || err,
        }),
      }, {
        content: null,
      });
    }
  }

  async function handleRepinChannel({ interaction, guildId, lang, replyChannelNotice, editChannelEmbed }) {
    const channel = await resolveMonitorChannelForAction({
      interaction,
      guildId,
      lang,
      replyChannelNotice,
    });
    if (!channel) return;

    await deferEphemeralReply(interaction);
    const welcome = await postRaidChannelWelcome(channel, interaction.client.user.id, guildId);
    const newKey = welcome.posted
      ? welcome.pinned
        ? "newPostedPinned"
        : "newPostedNoPin"
      : "newNotPosted";
    const embed = new EmbedBuilder()
      .setColor(welcome.posted && welcome.pinned ? UI.colors.success : UI.colors.progress)
      .setTitle(`${UI.icons.roster} ${t("raid-channel.repin.title", lang)}`)
      .setDescription(`<#${channel.id}>`)
      .addFields(
        {
          name: t("raid-channel.repin.removedField", lang),
          value: `${welcome.removedOldCount}`,
          inline: true,
        },
        {
          name: t("raid-channel.repin.newField", lang),
          value: t(`raid-channel.repin.${newKey}`, lang),
          inline: true,
        },
      )
      .setTimestamp();
    await editChannelEmbed(embed);
  }

  return {
    handleSetChannel,
    handleShowChannel,
    handleClearChannel,
    handleCleanupChannel,
    handleRepinChannel,
  };
}

module.exports = {
  createRaidChannelCoreActions,
  RAID_CHANNEL_GREETING_TTL_MS,
};
