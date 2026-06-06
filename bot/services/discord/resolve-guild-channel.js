"use strict";

/**
 * services/discord/resolve-guild-channel.js
 * Shared "resolve a guild channel by ID" helper for the announcement
 * schedulers (auto-cleanup, maintenance, weekly-reset, stuck-nudge). Each
 * site previously inlined the same cache-then-fetch dance; centralising it
 * keeps the cache-miss fetch fallback + swallow-on-failure behaviour
 * identical across every scheduler, so a future change to the lookup rules
 * only has to happen in one place.
 */

/**
 * Look up a guild channel by ID, preferring the in-memory cache and falling
 * back to a single REST fetch on a cache miss. Returns null (never throws)
 * on any miss - empty channelId, guild not cached, channel absent, or the
 * fetch rejecting - so callers can guard with a plain `if (!channel)`.
 * @param {import("discord.js").Client} client - the bot client
 * @param {string} guildId - snowflake of the guild the channel lives in
 * @param {string} channelId - target channel snowflake (nullable)
 * @returns {Promise<import("discord.js").GuildBasedChannel|null>} channel or null
 */
async function resolveGuildChannel(client, guildId, channelId) {
  if (!channelId) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  let channel = guild.channels.cache.get(channelId);
  if (!channel) {
    try {
      channel = await guild.channels.fetch(channelId);
    } catch {
      return null;
    }
  }
  return channel || null;
}

module.exports = { resolveGuildChannel };
