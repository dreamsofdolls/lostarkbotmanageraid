"use strict";

const {
  NoticeKind,
  buildErrorDetailField,
  buildNoticeEmbed,
  deferEphemeralReply,
} = require("../../../utils/raid/common/shared");

const RAID_CHANNEL_GREETING_TTL_MS = 2 * 60 * 1000;

// The repin result by what happened to the new welcome: anything short of
// posted and pinned is partial.
const REPIN_RESULTS = Object.freeze({
  pinned: { kind: NoticeKind.DONE, stem: "success", welcomeKey: "newPostedPinned" },
  unpinned: { kind: NoticeKind.PARTIAL, stem: "partial", welcomeKey: "newPostedNoPin" },
  notPosted: { kind: NoticeKind.PARTIAL, stem: "partial", welcomeKey: "newNotPosted" },
});

function repinResult(welcome) {
  if (!welcome.posted) return REPIN_RESULTS.notPosted;
  return welcome.pinned ? REPIN_RESULTS.pinned : REPIN_RESULTS.unpinned;
}

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
  cleanupAndRefreshRaidChannel,
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
    const { healthy, error } = getMonitorCacheHealth();
    const errorSuffix = error
        ? t("raid-channel.show.cacheUnhealthyErrorSuffix", lang, { error })
        : "";
    return [
      !isTextMonitorEnabled()
        ? t("raid-channel.show.monitorDisabledNote", lang, { icon: UI.icons.warn })
        : "",
      !healthy
        ? t("raid-channel.show.cacheUnhealthyNote", lang, {
            icon: UI.icons.warn,
            errorSuffix,
          })
        : "",
    ].filter(Boolean);
  }

  function appendShowNotes(lines, broadcastLangLine, deployNotes) {
    return [
      ...lines,
      ...(broadcastLangLine ? ["", broadcastLangLine] : []),
      ...(deployNotes.length > 0 ? ["", ...deployNotes] : []),
    ];
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

  async function loadProtectedWelcomeIds(guildId, channelId) {
    try {
      const cfg = await GuildConfig.findOne({ guildId })
        .select("welcomeMessageId welcomeChannelId")
        .lean();
      if (!cfg?.welcomeMessageId) return [];
      if (cfg.welcomeChannelId && cfg.welcomeChannelId !== channelId) return [];
      return [cfg.welcomeMessageId];
    } catch (err) {
      console.warn("[raid-channel] welcome protection read failed:", err?.message || err);
      return [];
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

  async function handleSetChannel({ interaction, guildId, lang, editChannelEmbed, replyChannelNotice }) {
    const channel = interaction.options.getChannel("channel");
    if (!channel) {
      await replyChannelNotice({
        kind: NoticeKind.INPUT,
        title: t("raid-channel.set.missingChannelTitle", lang),
        description: t("raid-channel.set.missingChannelDescription", lang),
        tip: t("raid-channel.set.missingChannelTip", lang),
      });
      return;
    }

    if (!isTextMonitorEnabled()) {
      await replyChannelNotice({
        kind: NoticeKind.GUARD,
        title: t("raid-channel.set.monitorDisabledTitle", lang),
        description: t("raid-channel.set.monitorDisabledDescription", lang),
        tip: t("raid-channel.set.monitorDisabledTip", lang),
      });
      return;
    }

    const botMember = interaction.guild?.members?.me;
    const missing = getMissingBotChannelPermissions(channel, botMember);
    if (missing.length > 0) {
      await replyChannelNotice({
        kind: NoticeKind.GUARD,
        title: t("raid-channel.set.missingPermsTitle", lang),
        description: t("raid-channel.set.missingPermsDescription", lang, {
          channelId: channel.id,
          missing: missing.join(", "),
        }),
        tip: t("raid-channel.set.missingPermsTip", lang),
      });
      return;
    }

    // The config write, welcome post and pin, stale-welcome cleanup and
    // greeting below can outlast Discord's 3-second window.
    await deferEphemeralReply(interaction);
    const previousChannelId = getCachedMonitorChannelId(guildId);
    await GuildConfig.findOneAndUpdate(
      { guildId },
      { guildId, raidChannelId: channel.id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    setCachedMonitorChannelId(guildId, channel.id);

    const welcome = await postRaidChannelWelcome(
      channel,
      interaction.client.user.id,
      guildId,
      {
        client: interaction.client,
        previousChannelId,
      }
    );
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
    await editChannelEmbed(embed);
  }

  async function handleShowChannel({ interaction, guildId, lang, replyChannelEmbed }) {
    const channelId = getCachedMonitorChannelId(guildId);
    const embed = new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(`${UI.icons.info} ${t("raid-channel.show.title", lang)}`);
    const deployNotes = buildDeployNotes(lang);
    const broadcastLangLine = await loadBroadcastLanguageLine(guildId, lang);

    if (!channelId) {
      const lines = appendShowNotes(
        [t("raid-channel.show.noConfigLine", lang)],
        broadcastLangLine,
        deployNotes
      );
      embed.setDescription(lines.join("\n"));
      await replyChannelEmbed(embed);
      return;
    }

    const channel = await resolveRaidMonitorChannel(interaction, channelId);
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
    embed.setDescription(appendShowNotes(lines, broadcastLangLine, deployNotes).join("\n"));
    await replyChannelEmbed(embed);
  }

  async function handleClearChannel({ guildId, lang, replyChannelEmbed }) {
    await GuildConfig.findOneAndUpdate(
      { guildId },
      { $set: { raidChannelId: null, autoCleanupEnabled: false } }
    );
    setCachedMonitorChannelId(guildId, null);
    await replyChannelEmbed(buildNoticeEmbed(EmbedBuilder, {
      kind: NoticeKind.DONE,
      title: t("raid-channel.clear.title", lang),
      description: t("raid-channel.clear.description", lang),
      tip: t("raid-channel.clear.tip", lang),
    }));
  }

  async function resolveMonitorChannelForAction({ interaction, guildId, lang, replyChannelNotice }) {
    const channelId = getCachedMonitorChannelId(guildId);
    if (!channelId) {
      await replyChannelNotice({
        kind: NoticeKind.EMPTY,
        title: t("raid-channel.noChannelTitle", lang),
        description: t("raid-channel.noChannelDescription", lang),
        tip: t("raid-channel.noChannelTip", lang),
      });
      return null;
    }

    const channel = await resolveRaidMonitorChannel(interaction, channelId);
    if (!channel) {
      await replyChannelNotice({
        kind: NoticeKind.GUARD,
        title: t("raid-channel.cleanup.channelGoneTitle", lang),
        description: t("raid-channel.cleanup.channelGoneDescription", lang, { channelId }),
        tip: t("raid-channel.cleanup.channelGoneTip", lang),
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
      const protectedMessageIds = await loadProtectedWelcomeIds(guildId, channel.id);
      const { deleted, skippedOld } = await cleanupAndRefreshRaidChannel(channel, {
        botUserId: interaction.client.user.id,
        client: interaction.client,
        guildId,
        protectedMessageIds,
      });
      await editChannelEmbed(buildNoticeEmbed(EmbedBuilder, {
        kind: NoticeKind.DONE,
        title: t("raid-channel.cleanup.successTitle", lang),
        description: t("raid-channel.cleanup.successDescription", lang, { channelId: channel.id }),
        fields: [
          {
            name: t("raid-channel.cleanup.deletedField", lang),
            value: t("raid-channel.cleanup.deletedValue", lang, { count: deleted }),
            inline: true,
          },
          skippedOld > 0 && {
            name: t("raid-channel.cleanup.skippedField", lang),
            value: `${skippedOld}`,
            inline: true,
          },
        ],
        tip: t("raid-channel.cleanup.successTip", lang),
      }));
    } catch (err) {
      console.error("[raid-channel] manual cleanup failed:", err?.message || err);
      await editChannelNotice({
        kind: NoticeKind.FAILURE,
        title: t("raid-channel.cleanup.failTitle", lang),
        description: t("raid-channel.cleanup.failDescription", lang, { channelId: channel.id }),
        fields: [buildErrorDetailField(err, lang)],
        tip: t("raid-channel.cleanup.failTip", lang),
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
    const welcome = await postRaidChannelWelcome(
      channel,
      interaction.client.user.id,
      guildId,
      { client: interaction.client }
    );
    const result = repinResult(welcome);
    await editChannelEmbed(buildNoticeEmbed(EmbedBuilder, {
      kind: result.kind,
      title: t(`raid-channel.repin.${result.stem}Title`, lang),
      description: t(`raid-channel.repin.${result.stem}Description`, lang, { channelId: channel.id }),
      fields: [
        {
          name: t("raid-channel.repin.removedField", lang),
          value: `${welcome.removedOldCount}`,
          inline: true,
        },
        {
          name: t("raid-channel.repin.newField", lang),
          value: t(`raid-channel.repin.${result.welcomeKey}`, lang),
          inline: true,
        },
      ],
      tip: t(`raid-channel.repin.${result.stem}Tip`, lang),
    }));
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
};
