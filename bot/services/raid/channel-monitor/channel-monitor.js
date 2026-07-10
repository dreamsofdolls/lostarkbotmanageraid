"use strict";

const {
  applyRaidChannelWritePlans,
  buildWritePlanSegments,
  findAccessibleCharacterInAccounts,
  resolveRaidChannelWritePlans,
} = require("./channel-monitor-write-plans");
const { createMonitorChannelCache } = require("./channel-monitor-cache");
const {
  cleanupRaidChannelMessages,
  resolveRaidMonitorChannel,
} = require("./channel-monitor-cleanup");
const { createRaidChannelEmbedBuilders } = require("./channel-monitor-embeds");
const { createRaidChannelHintService } = require("./channel-monitor-hints");
const {
  createRaidChannelMessageHandler,
} = require("./channel-monitor-message-handler");
const { createRaidChannelPermissionHelpers } = require("./channel-monitor-permissions");
const { createRaidChannelWelcomeService } = require("./channel-monitor-welcome");
const { parseRaidMessage } = require("./channel-monitor-parser");
const User = require("../../../models/user");
const { t, getUserLanguage, getGuildLanguage } = require("../../i18n");

function createRaidChannelMonitorService({
  PermissionFlagsBits,
  EmbedBuilder,
  UI,
  GuildConfig,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  getRaidLabel,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId = null,
  getAccessibleAccounts,
  getAnnouncementsConfig,
  normalizeName,
}) {
  const {
    loadMonitorChannelCache,
    getMonitorCacheHealth,
    getCachedMonitorChannelId,
    setCachedMonitorChannelId,
  } = createMonitorChannelCache({ GuildConfig });
  const {
    isTextMonitorEnabled,
    getMissingBotChannelPermissions,
    getMissingAnnouncementChannelPermissions,
  } = createRaidChannelPermissionHelpers({ PermissionFlagsBits });
  const {
    buildRaidChannelMultiResultEmbed,
    buildRaidChannelWelcomeEmbed,
  } = createRaidChannelEmbedBuilders({ EmbedBuilder, UI });
  const { postRaidChannelWelcome } = createRaidChannelWelcomeService({
    GuildConfig,
    getGuildLanguage,
    buildRaidChannelWelcomeEmbed,
  });
  const hintService = createRaidChannelHintService({
    UI,
    UserModel: User,
    normalizeName,
    getUserLanguage,
  });
  const { handleRaidChannelMessage } = createRaidChannelMessageHandler({
    GuildConfig,
    RAID_REQUIREMENT_MAP,
    UI,
    applyRaidSetBatchForDiscordId,
    applyRaidSetForDiscordId,
    buildRaidChannelMultiResultEmbed,
    getAccessibleAccounts,
    getAnnouncementsConfig,
    getCachedMonitorChannelId,
    getGatesForRaid,
    getRaidLabel,
    getUserLanguage,
    parseRaidMessage,
    t,
    UserModel: User,
    ...hintService,
  });

  return {
    loadMonitorChannelCache,
    getMonitorCacheHealth,
    getCachedMonitorChannelId,
    setCachedMonitorChannelId,
    isTextMonitorEnabled,
    getMissingBotChannelPermissions,
    getMissingAnnouncementChannelPermissions,
    parseRaidMessage,
    handleRaidChannelMessage,
    cleanupRaidChannelMessages,
    postRaidChannelWelcome,
    resolveRaidMonitorChannel,
  };
}

module.exports = {
  createRaidChannelMonitorService,
  _test: {
    findAccessibleCharacterInAccounts,
    resolveRaidChannelWritePlans,
    applyRaidChannelWritePlans,
    buildWritePlanSegments,
  },
};
