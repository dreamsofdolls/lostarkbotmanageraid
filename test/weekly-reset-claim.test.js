"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  postWeeklyResetAnnouncements,
} = require("../bot/services/raid/schedulers/weekly-reset");

test("overlapping weekly announcers atomically send once per guild and reset key", async () => {
  const targetKey = "2026-W35";
  let storedKey = "2026-W34";
  let sends = 0;
  const cfg = {
    guildId: "guild-1",
    raidChannelId: "channel-1",
    lastWeeklyAnnouncementKey: "2026-W34",
    announcements: { weeklyReset: { enabled: true } },
  };
  const GuildConfigModel = {
    find: () => ({ lean: async () => [{ ...cfg }] }),
    async findOneAndUpdate(filter, update) {
      if (filter.lastWeeklyAnnouncementKey?.$ne) {
        if (storedKey === targetKey) return null;
        const previous = { ...cfg, lastWeeklyAnnouncementKey: storedKey };
        storedKey = update.$set.lastWeeklyAnnouncementKey;
        return previous;
      }
      return null;
    },
  };
  const channel = {
    async send() {
      sends += 1;
      return { delete: async () => {} };
    },
  };
  const deps = {
    GuildConfigModel,
    getGuildLanguageFn: async () => "vi",
    resolveGuildChannelFn: async () => channel,
    setTimeoutFn: () => null,
  };

  await Promise.all([
    postWeeklyResetAnnouncements({}, targetKey, deps),
    postWeeklyResetAnnouncements({}, targetKey, deps),
  ]);

  assert.equal(sends, 1);
  assert.equal(storedKey, targetKey);
});

test("failed weekly send rolls the exact claim back for the next tick", async () => {
  const targetKey = "2026-W35";
  const updates = [];
  const cfg = {
    guildId: "guild-1",
    raidChannelId: "channel-1",
    lastWeeklyAnnouncementKey: "2026-W34",
    announcements: { weeklyReset: { enabled: true } },
  };
  const GuildConfigModel = {
    find: () => ({ lean: async () => [cfg] }),
    async findOneAndUpdate(filter, update, options) {
      updates.push({ filter, update, options });
      return { ...cfg };
    },
  };

  await postWeeklyResetAnnouncements({}, targetKey, {
    GuildConfigModel,
    getGuildLanguageFn: async () => "vi",
    resolveGuildChannelFn: async () => ({
      async send() {
        throw new Error("Discord unavailable");
      },
    }),
    setTimeoutFn: () => null,
  });

  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0], {
    filter: {
      guildId: "guild-1",
      lastWeeklyAnnouncementKey: { $ne: targetKey },
      "announcements.weeklyReset.enabled": { $ne: false },
      raidChannelId: "channel-1",
      "announcements.weeklyReset.channelId": null,
    },
    update: { $set: { lastWeeklyAnnouncementKey: targetKey } },
    options: { new: false },
  });
  assert.deepEqual(updates[1], {
    filter: { guildId: "guild-1", lastWeeklyAnnouncementKey: targetKey },
    update: { $set: { lastWeeklyAnnouncementKey: "2026-W34" } },
    options: { new: true },
  });
});
