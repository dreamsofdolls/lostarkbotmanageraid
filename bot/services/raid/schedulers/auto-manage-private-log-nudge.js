"use strict";

const { resolveGuildChannel } = require("../../discord/resolve-guild-channel");

const PRIVATE_LOG_NUDGE_TTL_MS = 30 * 60 * 1000;
const PRIVATE_LOG_NUDGE_DEDUP_MS = 7 * 24 * 60 * 60 * 1000;

function loadDiscordComponents() {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
  return { ActionRowBuilder, ButtonBuilder, ButtonStyle };
}

function createPrivateLogNudgeService({
  GuildConfig,
  User,
  getAnnouncementsConfig,
  getUserLanguage,
  t,
  postChannelAnnouncement,
  privateLogNudgeTtlMs = PRIVATE_LOG_NUDGE_TTL_MS,
  privateLogNudgeDedupMs = PRIVATE_LOG_NUDGE_DEDUP_MS,
  nowMs = () => Date.now(),
  discordComponents = null,
}) {
  function buildSwitchToLocalComponents(discordId, targetLang) {
    const {
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
    } = discordComponents || loadDiscordComponents();
    const switchBtn = new ButtonBuilder()
      .setCustomId(`stuck-nudge:switch-to-local:${discordId}`)
      .setLabel(t("announcements.stuck-nudge.switchButtonLabel", targetLang))
      .setEmoji("\u{1F310}")
      .setStyle(ButtonStyle.Primary);
    return [new ActionRowBuilder().addComponents(switchBtn)];
  }

  async function nudgeStuckPrivateLogUser(client, discordId) {
    if (!client) return;
    let userDoc;
    try {
      userDoc = await User.findOne({ discordId }).select("lastPrivateLogNudgeAt").lean();
    } catch (err) {
      console.warn(`[auto-manage daily] nudge lookup failed user=${discordId}:`, err?.message || err);
      return;
    }
    if (!userDoc) return;
    const now = nowMs();
    if (userDoc.lastPrivateLogNudgeAt && now - userDoc.lastPrivateLogNudgeAt < privateLogNudgeDedupMs) {
      return;
    }

    let configs;
    try {
      configs = await GuildConfig.find({
        $or: [
          { raidChannelId: { $ne: null } },
          { "announcements.stuckPrivateLogNudge.channelId": { $ne: null } },
        ],
      }).lean();
    } catch (err) {
      console.warn(`[auto-manage daily] nudge config load failed user=${discordId}:`, err?.message || err);
      return;
    }

    for (const cfg of configs) {
      const announcements = getAnnouncementsConfig(cfg);
      if (!announcements.stuckPrivateLogNudge.enabled) continue;
      const guild = client.guilds.cache.get(cfg.guildId);
      if (!guild) continue;
      if (!guild.members.cache.has(discordId)) continue;

      const targetChannelId = announcements.stuckPrivateLogNudge.channelId || cfg.raidChannelId;
      const channel = await resolveGuildChannel(client, cfg.guildId, targetChannelId);
      if (!channel) continue;

      const targetLang = await getUserLanguage(discordId, { UserModel: User });
      const sent = await postChannelAnnouncement(
        channel,
        t("announcements.stuck-nudge.body", targetLang, { discordId }),
        privateLogNudgeTtlMs,
        "auto-manage private-log nudge",
        buildSwitchToLocalComponents(discordId, targetLang)
      );
      if (sent) {
        try {
          await User.findOneAndUpdate({ discordId }, { $set: { lastPrivateLogNudgeAt: now } });
        } catch (err) {
          console.warn(
            `[auto-manage daily] nudge dedup stamp failed user=${discordId}:`,
            err?.message || err
          );
        }
        return;
      }
    }
  }

  return {
    nudgeStuckPrivateLogUser,
    buildSwitchToLocalComponents,
  };
}

module.exports = {
  PRIVATE_LOG_NUDGE_TTL_MS,
  PRIVATE_LOG_NUDGE_DEDUP_MS,
  createPrivateLogNudgeService,
};
