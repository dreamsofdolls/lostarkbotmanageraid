"use strict";

function createRaidChannelResetService({
  cleanupRaidChannelMessages,
  postRaidChannelWelcome,
}) {
  async function cleanupAndRefreshRaidChannel(channel, {
    botUserId,
    client,
    guildId,
    protectedMessageIds = [],
  } = {}) {
    const cleanup = await cleanupRaidChannelMessages(channel, { protectedMessageIds });
    const welcome = await postRaidChannelWelcome(channel, botUserId, guildId, { client });
    if (!welcome.pinned || !welcome.persisted) {
      const err = new Error("welcome refresh failed after raid-channel cleanup");
      err.code = "RAID_CHANNEL_WELCOME_REFRESH_FAILED";
      err.cleanup = cleanup;
      err.welcome = welcome;
      throw err;
    }
    return { ...cleanup, welcome };
  }

  return { cleanupAndRefreshRaidChannel };
}

module.exports = {
  createRaidChannelResetService,
};
