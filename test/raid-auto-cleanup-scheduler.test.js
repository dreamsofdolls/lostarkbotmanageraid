"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getTargetCleanupSlotKey,
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
    findOneAndUpdate: async (filter, update, options) => {
      updates.push({ filter, update, options });
      return { ...cfg };
    },
  };
  const service = createAutoCleanupSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: () => ({
      hourlyCleanupNotice: { enabled: true },
      artistBedtime: { enabled: true },
      artistWakeup: { enabled: true },
    }),
    cleanupAndRefreshRaidChannel: async (target, options) => {
      cleanedChannel = target;
      cleanupOptions = options;
      return {
        deleted: 2,
        skippedOld: 1,
        welcome: { pinned: true, persisted: true },
      };
    },
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async (...args) => {
      posts.push(args);
      return { id: "message-1" };
    },
    nowDate: () => now,
  });

  const client = {
    user: { id: "bot" },
    guilds: { cache: new Map([["guild-1", makeGuild(channel)]]) },
  };
  await service.runAutoCleanupTick(client);

  assert.equal(cleanedChannel, channel);
  assert.deepEqual(cleanupOptions, {
    botUserId: "bot",
    client,
    guildId: "guild-1",
    protectedMessageIds: ["welcome-1"],
  });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].filter, {
    guildId: "guild-1",
    autoCleanupEnabled: true,
    raidChannelId: "channel-1",
    lastAutoCleanupKey: { $ne: getTargetCleanupSlotKey(now) },
  });
  assert.ok(updates[0].update.$set.lastAutoCleanupKey);
  assert.deepEqual(updates[0].options, { new: false });
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], channel);
  assert.equal(posts[0][2], 5 * 60 * 1000);
  assert.equal(posts[0][3], "raid-channel auto-cleanup");
});

test("auto-cleanup scheduler runs wakeup cleanup and stamps both dedup keys", async () => {
  const now = new Date(Date.UTC(2026, 3, 24, 1, 0, 0, 0));
  const dayKey = getTargetDayKeyForLang(now, "vi");
  const updates = [];
  const posts = [];
  const channel = {};
  const cfg = {
    guildId: "guild-wakeup",
    raidChannelId: "channel-1",
    welcomeMessageId: null,
    lastArtistWakeupKey: "old-day",
    lastAutoCleanupKey: "old-slot",
  };
  const GuildConfig = {
    find: () => ({ lean: async () => [cfg] }),
    findOneAndUpdate: async (filter, update, options) => {
      updates.push({ filter, update, options });
      return { ...cfg };
    },
  };
  const service = createAutoCleanupSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: () => ({
      artistWakeup: { enabled: true },
    }),
    cleanupAndRefreshRaidChannel: async (target, options) => {
      assert.equal(target, channel);
      assert.deepEqual(options.protectedMessageIds, []);
      return { deleted: 3, skippedOld: 0 };
    },
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async (...args) => {
      posts.push(args);
      return { id: "message-wakeup" };
    },
    nowDate: () => now,
  });
  const client = {
    user: { id: "bot" },
    guilds: { cache: new Map([["guild-wakeup", makeGuild(channel)]]) },
  };

  await service.runAutoCleanupTick(client);

  assert.deepEqual(updates, [
    {
      filter: {
        guildId: "guild-wakeup",
        autoCleanupEnabled: true,
        raidChannelId: "channel-1",
        lastArtistWakeupKey: { $ne: dayKey },
      },
      options: { new: false },
      update: {
        $set: {
          lastArtistWakeupKey: dayKey,
          lastAutoCleanupKey: "2026-04-24T08:00",
        },
      },
    },
  ]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], channel);
  assert.equal(posts[0][2], 10 * 60 * 1000);
  assert.equal(posts[0][3], "raid-channel artist-wakeup");
});

test("overlapping runtime instances atomically claim one auto-cleanup slot", async () => {
  const now = new Date(Date.UTC(2026, 3, 22, 2, 0, 0, 0));
  const targetKey = getTargetCleanupSlotKey(now);
  let storedKey = "old-slot";
  let cleanups = 0;
  const channel = {};
  const cfg = {
    guildId: "guild-race",
    raidChannelId: "channel-1",
    lastArtistWakeupKey: getTargetDayKeyForLang(now, "vi"),
    lastAutoCleanupKey: "old-slot",
  };
  const GuildConfig = {
    find: () => ({ lean: async () => [{ ...cfg }] }),
    async findOneAndUpdate(filter, update) {
      if (filter.lastAutoCleanupKey?.$ne) {
        if (storedKey === targetKey) return null;
        const previous = { ...cfg, lastAutoCleanupKey: storedKey };
        storedKey = update.$set.lastAutoCleanupKey;
        return previous;
      }
      return null;
    },
  };
  const service = createAutoCleanupSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: () => ({ hourlyCleanupNotice: { enabled: false } }),
    cleanupAndRefreshRaidChannel: async () => {
      cleanups += 1;
      return { deleted: 0, skippedOld: 0 };
    },
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async () => null,
    nowDate: () => now,
  });
  const client = {
    user: { id: "bot" },
    guilds: { cache: new Map([["guild-race", makeGuild(channel)]]) },
  };

  await Promise.all([
    service.runAutoCleanupTick(client),
    service.runAutoCleanupTick(client),
  ]);

  assert.equal(cleanups, 1);
  assert.equal(storedKey, targetKey);
});

test("overlapping runtime instances atomically send one artist-bedtime notice", async () => {
  const now = new Date(Date.UTC(2026, 3, 22, 20, 30, 0, 0));
  const dayKey = getTargetDayKeyForLang(now, "vi");
  let storedKey = "old-day";
  let posts = 0;
  const channel = {};
  const cfg = {
    guildId: "guild-bedtime-race",
    raidChannelId: "channel-1",
    lastArtistBedtimeKey: "old-day",
  };
  const GuildConfig = {
    find: () => ({ lean: async () => [{ ...cfg }] }),
    async findOneAndUpdate(filter, update) {
      if (filter.lastArtistBedtimeKey?.$ne) {
        if (storedKey === dayKey) return null;
        const previous = { ...cfg, lastArtistBedtimeKey: storedKey };
        storedKey = update.$set.lastArtistBedtimeKey;
        return previous;
      }
      return null;
    },
  };
  const service = createAutoCleanupSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: () => ({ artistBedtime: { enabled: true } }),
    cleanupAndRefreshRaidChannel: async () => {
      throw new Error("quiet hours must not run cleanup");
    },
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async () => {
      posts += 1;
      return { id: "bedtime-message" };
    },
    nowDate: () => now,
  });
  const client = {
    user: { id: "bot" },
    guilds: { cache: new Map([["guild-bedtime-race", makeGuild(channel)]]) },
  };

  await Promise.all([
    service.runAutoCleanupTick(client),
    service.runAutoCleanupTick(client),
  ]);

  assert.equal(posts, 1);
  assert.equal(storedKey, dayKey);
});

test("failed cleanup conditionally rolls its slot claim back for retry", async () => {
  const now = new Date(Date.UTC(2026, 3, 22, 2, 0, 0, 0));
  const targetKey = getTargetCleanupSlotKey(now);
  const updates = [];
  const channel = {};
  const cfg = {
    guildId: "guild-retry",
    raidChannelId: "channel-1",
    lastArtistWakeupKey: getTargetDayKeyForLang(now, "vi"),
    lastAutoCleanupKey: "old-slot",
  };
  const GuildConfig = {
    find: () => ({ lean: async () => [cfg] }),
    async findOneAndUpdate(filter, update, options) {
      updates.push({ filter, update, options });
      return { ...cfg };
    },
  };
  const service = createAutoCleanupSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: () => ({}),
    cleanupAndRefreshRaidChannel: async () => {
      throw new Error("Discord unavailable");
    },
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async () => null,
    nowDate: () => now,
  });
  const client = {
    user: { id: "bot" },
    guilds: { cache: new Map([["guild-retry", makeGuild(channel)]]) },
  };

  await service.runAutoCleanupTick(client);

  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1], {
    filter: { guildId: "guild-retry", lastAutoCleanupKey: targetKey },
    update: { $set: { lastAutoCleanupKey: "old-slot" } },
    options: { new: true },
  });
});
