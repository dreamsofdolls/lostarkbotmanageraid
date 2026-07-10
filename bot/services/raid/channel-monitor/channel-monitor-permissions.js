"use strict";

function createRaidChannelPermissionHelpers({ PermissionFlagsBits }) {
  const BOT_CHANNEL_PERMS = [
    { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
    { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
    { flag: PermissionFlagsBits.ManageMessages, label: "Manage Messages" },
    { flag: PermissionFlagsBits.PinMessages, label: "Pin Messages" },
    { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
    { flag: PermissionFlagsBits.EmbedLinks, label: "Embed Links" },
  ];
  const ANNOUNCEMENT_CHANNEL_PERMS = [
    { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
    { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  ];

  function isTextMonitorEnabled() {
    return process.env.TEXT_MONITOR_ENABLED !== "false";
  }

  function getMissingChannelPermissions(channel, botMember, requiredPerms) {
    if (!channel || !botMember) return requiredPerms.map((permission) => permission.label);
    const perms = channel.permissionsFor(botMember);
    if (!perms) return requiredPerms.map((permission) => permission.label);
    return requiredPerms
      .filter((permission) => !perms.has(permission.flag))
      .map((permission) => permission.label);
  }

  function getMissingBotChannelPermissions(channel, botMember, options = {}) {
    const requiredPerms = Array.isArray(options?.requiredPerms)
      ? options.requiredPerms
      : BOT_CHANNEL_PERMS;
    return getMissingChannelPermissions(channel, botMember, requiredPerms);
  }

  function getMissingAnnouncementChannelPermissions(channel, botMember) {
    return getMissingChannelPermissions(channel, botMember, ANNOUNCEMENT_CHANNEL_PERMS);
  }

  return {
    BOT_CHANNEL_PERMS,
    ANNOUNCEMENT_CHANNEL_PERMS,
    isTextMonitorEnabled,
    getMissingChannelPermissions,
    getMissingBotChannelPermissions,
    getMissingAnnouncementChannelPermissions,
  };
}

module.exports = {
  createRaidChannelPermissionHelpers,
};
