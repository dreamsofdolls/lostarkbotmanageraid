/**
 * handlers/raid/channel.js
 * /raid-channel command composition. Keeps auth/autocomplete at the root and
 * delegates concrete config actions to channel/* modules.
 */

"use strict";

const {
  editEmbed,
  editNotice,
  replyEmbed,
  replyNotice,
} = require("../../utils/raid/common/shared");
const {
  t,
  getUserLanguage,
  getGuildLanguage,
  setGuildLanguage,
  SUPPORTED_LANGUAGES,
} = require("../../services/i18n");
const {
  buildRaidChannelActionChoices,
} = require("./channel/action-options");
const {
  createRaidChannelCoreActions,
} = require("./channel/core-actions");
const {
  createRaidChannelLanguageActions,
} = require("./channel/language-actions");
const {
  createRaidChannelScheduleActions,
} = require("./channel/schedule-actions");

/**
 * Build the /raid-channel command handler factory.
 * @param {object} deps - injected dependencies (discord.js builders,
 *   PermissionFlagsBits, GuildConfig/User models, monitor cache + scheduler
 *   helpers · see the destructure).
 * @returns {{
 *   handleRaidChannelCommand: Function,
 *   handleRaidChannelAutocomplete: Function,
 * }} handlers wired into commands.js dispatch + autocomplete maps
 */
function createRaidChannelCommand({
  EmbedBuilder,
  PermissionFlagsBits,
  UI,
  User,
  GuildConfig,
  normalizeName,
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
  getTargetCleanupSlotKey,
}) {
  /**
   * Autocomplete for `/raid-channel config action:*`. Returns the full action
   * catalog filtered by the typed prefix and current schedule state.
   */
  async function handleRaidChannelAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name !== "action") {
        await interaction.respond([]).catch(() => {});
        return;
      }
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      let autoCleanupEnabled = false;
      if (interaction.guildId) {
        try {
          const cfg = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
          autoCleanupEnabled = !!cfg?.autoCleanupEnabled;
        } catch (err) {
          console.warn("[autocomplete] raid-channel config load failed:", err?.message || err);
        }
      }
      const choices = buildRaidChannelActionChoices({
        lang,
        needle: focused.value || "",
        autoCleanupEnabled,
        t,
        normalizeName,
      });
      await interaction.respond(choices).catch(() => {});
    } catch (err) {
      console.error("[autocomplete] raid-channel error:", err?.message || err);
      await interaction.respond([]).catch(() => {});
    }
  }

  const {
    handleSetChannel,
    handleShowChannel,
    handleClearChannel,
    handleCleanupChannel,
    handleRepinChannel,
  } = createRaidChannelCoreActions({
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
  });

  const { handleSetLanguage } = createRaidChannelLanguageActions({
    EmbedBuilder,
    UI,
    GuildConfig,
    getGuildLanguage,
    setGuildLanguage,
    SUPPORTED_LANGUAGES,
    t,
  });

  const { handleScheduleToggle } = createRaidChannelScheduleActions({
    EmbedBuilder,
    UI,
    GuildConfig,
    getCachedMonitorChannelId,
    getTargetCleanupSlotKey,
    t,
  });

  const actionHandlers = {
    set: handleSetChannel,
    show: handleShowChannel,
    clear: handleClearChannel,
    cleanup: handleCleanupChannel,
    repin: handleRepinChannel,
    "set-language": handleSetLanguage,
    "schedule-on": handleScheduleToggle,
    "schedule-off": handleScheduleToggle,
  };

  async function handleRaidChannelCommand(interaction) {
    const guildId = interaction.guildId;
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const replyChannelNotice = (options) => replyNotice(interaction, EmbedBuilder, options);
    const replyChannelEmbed = (embed) => replyEmbed(interaction, embed);
    const editChannelNotice = (options, extras) => editNotice(interaction, EmbedBuilder, options, extras);
    const editChannelEmbed = (embed) => editEmbed(interaction, embed);

    if (!guildId) {
      await replyChannelNotice({
        type: "warn",
        title: t("raid-channel.auth.serverOnlyTitle", lang),
        description: t("raid-channel.auth.serverOnlyDescription", lang),
      });
      return;
    }

    if (
      !interaction.memberPermissions ||
      !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
    ) {
      await replyChannelNotice({
        type: "lock",
        title: t("raid-channel.auth.manageGuildTitle", lang),
        description: t("raid-channel.auth.manageGuildDescription", lang),
      });
      return;
    }

    const action = interaction.options.getString("action", true);
    const handler = actionHandlers[action];
    if (!handler) return;

    await handler({
      action,
      interaction,
      guildId,
      lang,
      replyChannelEmbed,
      replyChannelNotice,
      editChannelEmbed,
      editChannelNotice,
    });
  }

  return {
    handleRaidChannelAutocomplete,
    handleRaidChannelCommand,
  };
}

module.exports = {
  createRaidChannelCommand,
};
