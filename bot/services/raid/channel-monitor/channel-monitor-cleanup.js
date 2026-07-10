"use strict";

const { raidChannelGuard } = require("./channel-monitor-guard");

const MAX_ITERATIONS = 20;

async function cleanupRaidChannelMessages(channel, {
  protectedMessageIds = [],
  channelGuard = raidChannelGuard,
} = {}) {
  return channelGuard.runExclusive(channel?.id, async () => {
    const protectedIds = new Set([
      ...Array.from(protectedMessageIds || []),
      ...channelGuard.getProtectedMessageIds(channel?.id),
    ].filter(Boolean).map(String));
    let totalDeleted = 0;
    let totalSkippedOld = 0;
    let before;

    for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
      const fetchOpts = { limit: 100 };
      if (before) fetchOpts.before = before;
      const fetched = await channel.messages.fetch(fetchOpts);
      if (fetched.size === 0) break;

      before = fetched.last()?.id;
      const toDelete = fetched.filter(
        (message) => !message.pinned && !protectedIds.has(String(message.id))
      );
      if (toDelete.size > 0) {
        const deleted = await channel.bulkDelete(toDelete, true);
        totalDeleted += deleted.size;
        totalSkippedOld += toDelete.size - deleted.size;
      }
      if (fetched.size < 100) break;
    }

    return { deleted: totalDeleted, skippedOld: totalSkippedOld };
  });
}

async function resolveRaidMonitorChannel(interaction, channelId) {
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

module.exports = {
  cleanupRaidChannelMessages,
  resolveRaidMonitorChannel,
};
