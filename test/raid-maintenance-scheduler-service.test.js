"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMaintenanceSchedulerService,
} = require("../bot/services/raid/schedulers/maintenance-scheduler");

function makeGuild(channel) {
  return {
    channels: {
      cache: new Map([["override-1", channel]]),
      fetch: async () => null,
    },
  };
}

test("maintenance scheduler claims the matching group and posts to override channel", async () => {
  const now = new Date(Date.UTC(2026, 3, 22, 4, 0, 0, 0)); // Wed 11:00 VN = T-3h
  const claims = [];
  const posts = [];
  const channel = {};
  const cfg = {
    guildId: "guild-1",
    raidChannelId: null,
    announcements: {
      maintenanceEarly: { enabled: true, channelId: "override-1" },
      maintenanceCountdown: { enabled: true, channelId: null },
    },
  };
  const GuildConfig = {
    find: (query) => {
      assert.ok(Array.isArray(query.$or));
      return { lean: async () => [cfg] };
    },
    findOneAndUpdate: async (filter, update, options) => {
      claims.push({ filter, update, options });
      return { ...cfg };
    },
  };
  const service = createMaintenanceSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: (doc) => doc.announcements,
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async (...args) => {
      posts.push(args);
      return { id: "message-1" };
    },
    nowDate: () => now,
  });

  await service.runMaintenanceTick({
    guilds: { cache: new Map([["guild-1", makeGuild(channel)]]) },
  });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].filter.guildId, "guild-1");
  assert.deepEqual(claims[0].filter.lastMaintenanceEarlyKey, { $ne: "2026-04-22:T-3h" });
  assert.deepEqual(claims[0].filter["announcements.maintenanceEarly.enabled"], { $ne: false });
  assert.deepEqual(claims[0].update.$set, { lastMaintenanceEarlyKey: "2026-04-22:T-3h" });
  assert.deepEqual(claims[0].options, { new: false });
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], channel);
  assert.equal(typeof posts[0][1], "string");
  assert.equal(posts[0][3], "maintenance T-3h");
});

test("maintenance scheduler retries once then releases a failed announcement claim", async () => {
  const now = new Date(Date.UTC(2026, 3, 22, 4, 0, 0, 0));
  const mutations = [];
  const posts = [];
  const waits = [];
  const channel = {};
  const cfg = {
    guildId: "guild-1",
    raidChannelId: null,
    lastMaintenanceEarlyKey: null,
    announcements: {
      maintenanceEarly: { enabled: true, channelId: "override-1" },
      maintenanceCountdown: { enabled: true, channelId: null },
    },
  };
  const GuildConfig = {
    find: () => ({ lean: async () => [cfg] }),
    findOneAndUpdate: async (filter, update, options) => {
      mutations.push({ filter, update, options });
      return { ...cfg };
    },
  };
  const service = createMaintenanceSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: (doc) => doc.announcements,
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async (...args) => {
      posts.push(args);
      return null;
    },
    nowDate: () => now,
    waitBeforeRetry: async (ms) => waits.push(ms),
  });

  await service.runMaintenanceTick({
    guilds: { cache: new Map([["guild-1", makeGuild(channel)]]) },
  });

  assert.equal(posts.length, 2);
  assert.deepEqual(waits, [1_000]);
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[1], {
    filter: {
      guildId: "guild-1",
      lastMaintenanceEarlyKey: "2026-04-22:T-3h",
    },
    update: { $set: { lastMaintenanceEarlyKey: null } },
    options: { new: true },
  });
});
