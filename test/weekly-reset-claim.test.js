"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  postWeeklyResetAnnouncements,
} = require("../bot/services/raid/schedulers/weekly-reset");

// Wed 17:30 VN, just after the reset: a clock Artist is awake for.
const AWAKE_CLOCK = () => new Date(Date.UTC(2026, 7, 26, 10, 30, 0, 0));

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
    nowDate: AWAKE_CLOCK,
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
    nowDate: AWAKE_CLOCK,
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
    options: { returnDocument: "before" },
  });
  assert.deepEqual(updates[1], {
    filter: { guildId: "guild-1", lastWeeklyAnnouncementKey: targetKey },
    update: { $set: { lastWeeklyAnnouncementKey: "2026-W34" } },
    options: { returnDocument: "after" },
  });
});

test("weekly reset announcement is not posted while Artist sleeps", async () => {
  const claims = [];
  let sends = 0;
  const cfg = {
    guildId: "guild-1",
    raidChannelId: "channel-1",
    lastWeeklyAnnouncementKey: "2026-W34",
    announcements: { weeklyReset: { enabled: true } },
  };

  await postWeeklyResetAnnouncements({}, "2026-W35", {
    GuildConfigModel: {
      find: () => ({ lean: async () => [cfg] }),
      async findOneAndUpdate(filter, update) {
        claims.push(update);
        return { ...cfg };
      },
    },
    getGuildLanguageFn: async () => "vi",
    resolveGuildChannelFn: async () => ({
      async send() {
        sends += 1;
        return { delete: async () => {} };
      },
    }),
    setTimeoutFn: () => null,
    // Thu 03:00 VN: a catch-up tick after a restart inside the sleep window.
    nowDate: () => new Date(Date.UTC(2026, 7, 26, 20, 0, 0, 0)),
  });

  assert.equal(claims.length, 0);
  assert.equal(sends, 0);
});
