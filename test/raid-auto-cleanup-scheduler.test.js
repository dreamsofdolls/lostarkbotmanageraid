"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getTargetDayKeyForLang,
} = require("../bot/utils/raid/schedule/artist-clock");
const {
  createAutoCleanupSchedulerService,
} = require("../bot/services/raid/schedulers/auto-cleanup-scheduler");

function makeGuild(channel) {
  return {
    channels: {
      cache: new Map([["channel-1", channel]]),
      fetch: async () => null,
    },
  };
}

test("auto-cleanup scheduler runs normal cleanup and stamps the slot key", async () => {
  const now = new Date(Date.UTC(2026, 3, 22, 2, 0, 0, 0));
  const updates = [];
  const posts = [];
  let cleanedChannel = null;
  let cleanupOptions = null;
  const channel = {};
  const cfg = {
    guildId: "guild-1",
    raidChannelId: "channel-1",
    welcomeMessageId: "welcome-1",
    lastArtistWakeupKey: getTargetDayKeyForLang(now, "vi"),
    lastAutoCleanupKey: "old-slot",
  };
  const GuildConfig = {
    find: (query) => {
      assert.deepEqual(query, {
        autoCleanupEnabled: true,
        raidChannelId: { $ne: null },
      });
      return { lean: async () => [cfg] };
    },
    findOneAndUpdate: async (filter, update) => {
      updates.push({ filter, update });
      return {};
    },
  };
  const service = createAutoCleanupSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: () => ({
      hourlyCleanupNotice: { enabled: true },
      artistBedtime: { enabled: true },
      artistWakeup: { enabled: true },
    }),
    cleanupRaidChannelMessages: async (target, options) => {
      cleanedChannel = target;
      cleanupOptions = options;
      return { deleted: 2, skippedOld: 1 };
    },
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async (...args) => {
      posts.push(args);
      return { id: "message-1" };
    },
    nowDate: () => now,
  });

  await service.runAutoCleanupTick({
    guilds: { cache: new Map([["guild-1", makeGuild(channel)]]) },
  });

  assert.equal(cleanedChannel, channel);
  assert.deepEqual(cleanupOptions, { protectedMessageIds: ["welcome-1"] });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].filter, { guildId: "guild-1" });
  assert.ok(updates[0].update.$set.lastAutoCleanupKey);
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], channel);
  assert.equal(posts[0][2], 5 * 60 * 1000);
  assert.equal(posts[0][3], "raid-channel auto-cleanup");
});
