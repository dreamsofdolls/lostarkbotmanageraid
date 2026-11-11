"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const GuildConfigModel = require("../bot/models/guildConfig");
const {
  announcementSubdocDefaultEnabled,
  announcementSubdocKeys,
  announcementOverridableTypeKeys,
  announcementTypeEntry,
} = require("../bot/utils/raid/schedule/announcements");
const {
  createSchedulingHelpers,
} = require("../bot/utils/raid/schedule/scheduling");
const {
  WORLD_EVENT_REMINDER_TTL_MS,
  buildWorldEventReminderConfigQuery,
  nextWorldEventReminderBoundaryMs,
  resolveWorldEventReminderForNow,
  worldEventReminderMessageKey,
} = require("../bot/utils/raid/schedule/world-events");
const {
  createWorldEventReminderSchedulerService,
} = require("../bot/services/raid/schedulers/world-event-reminder-scheduler");
const { t } = require("../bot/services/i18n");

function utc(year, month, day, hour, minute, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
}

function makeGuild(channel) {
  return {
    channels: {
      cache: new Map([["override-1", channel]]),
      fetch: async () => null,
    },
  };
}

test("world-event reminder matches Chaos Gate inside its window and catches up", () => {
  // Mon Apr 27 2026 11:00 UTC-4 = 15:00 UTC.
  const exact = resolveWorldEventReminderForNow(utc(2026, 4, 27, 14, 55, 30));
  const catchUp = resolveWorldEventReminderForNow(utc(2026, 4, 27, 14, 57));

  assert.deepEqual(exact?.presetKeys, ["chaos_gate"]);
  assert.equal(exact?.spawnAtMs, Date.UTC(2026, 3, 27, 15, 0, 0, 0));
  assert.equal(catchUp?.key, exact?.key);
});
test("world-event reminder follows US Eastern standard time in winter", () => {
  // Thu Nov 5 2026: 11:00 EST = 16:00 UTC = 23:00 VN; the last spawn is
  // Fri 05:00 EST = 10:00 UTC.
  const daylightTime = resolveWorldEventReminderForNow(utc(2026, 11, 5, 14, 55));
  const firstSpawn = resolveWorldEventReminderForNow(utc(2026, 11, 5, 15, 55));
  const lastSpawn = resolveWorldEventReminderForNow(utc(2026, 11, 6, 9, 55));

  assert.equal(daylightTime, null);
  assert.deepEqual(firstSpawn?.presetKeys, ["chaos_gate"]);
  assert.equal(firstSpawn?.spawnAtMs, Date.UTC(2026, 10, 5, 16, 0, 0, 0));
  assert.equal(lastSpawn?.spawnAtMs, Date.UTC(2026, 10, 6, 10, 0, 0, 0));
});

test("world-event reminder opens 20 minutes before Friday's Field Boss and names it alone", () => {
  // Fri Nov 6 2026 11:00 EST = 16:00 UTC: Field Boss only, no Chaos Gate.
  const opens = resolveWorldEventReminderForNow(utc(2026, 11, 6, 15, 40));
  const tooEarly = resolveWorldEventReminderForNow(utc(2026, 11, 6, 15, 39));

  assert.deepEqual(opens?.presetKeys, ["field_boss"]);
  assert.equal(opens?.spawnAtMs, Date.UTC(2026, 10, 6, 16, 0, 0, 0));
  assert.equal(opens?.reminderAtMs, Date.UTC(2026, 10, 6, 15, 40, 0, 0));
  assert.equal(worldEventReminderMessageKey(opens?.presetKeys), "announcements.world-event-reminder.fieldBoss");
  assert.equal(tooEarly, null);
});

test("the Sunday reminder tells players to clear Chaos Gate first, then the Field Boss", () => {
  // Chaos Gate opens on the hour and the Field Boss spawns a few minutes
  // later, so players do both in that order rather than pick one.
  const vars = { spawnUnix: 1762444800, ttlMinutes: 21 };
  const copy = {
    vi: t("announcements.world-event-reminder.both", "vi", vars),
    en: t("announcements.world-event-reminder.both", "en", vars),
    jp: t("announcements.world-event-reminder.both", "jp", vars),
  };
  assert.match(copy.vi, /làm Chaos Gate trước rồi chạy qua boss/);
  assert.doesNotMatch(copy.vi, /chọn event/);
  assert.match(copy.en, /clear Chaos Gate first, then run to the boss/);
  assert.doesNotMatch(copy.en, /pick the event/);
  assert.match(copy.jp, /Chaos Gate を済ませてからボスへ/);
});

test("world-event reminder matches Field Boss alone on Tuesday", () => {
  const match = resolveWorldEventReminderForNow(utc(2026, 4, 28, 14, 56));
  assert.deepEqual(match?.presetKeys, ["field_boss"]);
  assert.equal(match?.spawnAtMs, Date.UTC(2026, 3, 28, 15, 0, 0, 0));
});

test("world-event reminder combines Sunday Chaos Gate and Field Boss", () => {
  const match = resolveWorldEventReminderForNow(utc(2026, 4, 26, 14, 55, 30));
  assert.deepEqual(match?.presetKeys, ["chaos_gate", "field_boss"]);
  assert.equal(worldEventReminderMessageKey(match?.presetKeys), "announcements.world-event-reminder.both");
});

test("overnight window includes the 05:00 spawn but not a synthetic 06:00 spawn", () => {
  // Saturday's source-day window crosses midnight. Final real spawn is
  // Sunday 05:00 UTC-4 = 09:00 UTC; 06:00 is only the window end.
  const finalSpawn = resolveWorldEventReminderForNow(utc(2026, 4, 26, 8, 55));
  const windowEnd = resolveWorldEventReminderForNow(utc(2026, 4, 26, 9, 55));

  assert.deepEqual(finalSpawn?.presetKeys, ["chaos_gate"]);
  assert.equal(finalSpawn?.spawnAtMs, Date.UTC(2026, 3, 26, 9, 0, 0, 0));
  assert.equal(windowEnd, null);
});

test("next reminder boundary advances past a reminder window already in progress", () => {
  const beforeWindow = nextWorldEventReminderBoundaryMs(utc(2026, 4, 27, 14, 0));
  const insideWindow = nextWorldEventReminderBoundaryMs(utc(2026, 4, 27, 14, 57));

  assert.equal(beforeWindow, Date.UTC(2026, 3, 27, 14, 40, 0, 0));
  assert.equal(insideWindow, Date.UTC(2026, 3, 27, 15, 40, 0, 0));
});

test("world-event reminder helpers reject invalid dates and lead windows consistently", () => {
  for (const [now, leadMs] of [
    ["not-a-date", 5 * 60 * 1000],
    [utc(2026, 4, 27, 14, 0), 0],
    [utc(2026, 4, 27, 14, 0), Number.NaN],
  ]) {
    assert.equal(resolveWorldEventReminderForNow(now, leadMs), null);
    assert.equal(nextWorldEventReminderBoundaryMs(now, leadMs), null);
  }
});

test("world-event reminder is opt-in for both lean legacy config and new schema docs", () => {
  const { getAnnouncementsConfig } = createSchedulingHelpers({
    announcementSubdocKeys,
    announcementSubdocDefaultEnabled,
  });
  const normalized = getAnnouncementsConfig({ guildId: "legacy" });
  const fresh = new GuildConfigModel({ guildId: "new-guild" });

  assert.equal(normalized.weeklyReset.enabled, true);
  assert.equal(normalized.worldEventReminder.enabled, false);
  assert.equal(fresh.announcements.worldEventReminder.enabled, false);
  assert.ok(announcementOverridableTypeKeys().includes("world-event-reminder"));
});

test("world-event config query requires explicit opt-in and a destination", () => {
  const query = buildWorldEventReminderConfigQuery();
  assert.equal(query["announcements.worldEventReminder.enabled"], true);
  assert.deepEqual(query.$or, [
    { raidChannelId: { $ne: null } },
    { "announcements.worldEventReminder.channelId": { $ne: null } },
  ]);
});

test("world-event scheduler claims once and posts the combined Sunday message", async () => {
  const now = utc(2026, 4, 26, 14, 57);
  const channel = { id: "override-1" };
  const cfg = {
    guildId: "guild-1",
    raidChannelId: null,
    lastWorldEventReminderKey: null,
    announcements: {
      worldEventReminder: { enabled: true, channelId: "override-1" },
    },
  };
  const finds = [];
  const claims = [];
  const posts = [];
  const GuildConfig = {
    find: (query) => {
      finds.push(query);
      return { lean: async () => [cfg] };
    },
    findOneAndUpdate: async (filter, update, options) => {
      claims.push({ filter, update, options });
      return { ...cfg };
    },
  };
  const service = createWorldEventReminderSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: (doc) => doc.announcements,
    getGuildLanguage: async () => "en",
    postChannelAnnouncement: async (...args) => {
      posts.push(args);
      return { id: "message-1" };
    },
    t: (key, lang, vars) => `${key}:${lang}:${vars.spawnUnix}`,
    nowDate: () => now,
  });
  const client = {
    guilds: {
      cache: new Map([
        [
          "guild-1",
          {
            channels: {
              cache: new Map([["override-1", channel]]),
              fetch: async () => null,
            },
          },
        ],
      ]),
    },
  };

  await service.runWorldEventReminderTick(client);

  assert.equal(finds.length, 1);
  assert.equal(finds[0]["announcements.worldEventReminder.enabled"], true);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].filter.guildId, "guild-1");
  assert.equal(claims[0].filter["announcements.worldEventReminder.enabled"], true);
  assert.match(claims[0].update.$set.lastWorldEventReminderKey, /^world-event:/);
  assert.deepEqual(claims[0].options, { returnDocument: "before" });
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], channel);
  assert.match(posts[0][1], /^announcements\.world-event-reminder\.both:en:/);
  assert.equal(posts[0][2], WORLD_EVENT_REMINDER_TTL_MS);
  assert.equal(posts[0][3], "world-event reminder");
});

test("world-event scheduler releases its dedup claim when Discord send fails", async () => {
  const now = utc(2026, 4, 26, 14, 57);
  const cfg = {
    guildId: "guild-1",
    raidChannelId: null,
    lastWorldEventReminderKey: null,
    announcements: {
      worldEventReminder: { enabled: true, channelId: "override-1" },
    },
  };
  const mutations = [];
  const GuildConfig = {
    find: () => ({ lean: async () => [cfg] }),
    findOneAndUpdate: async (filter, update, options) => {
      mutations.push({ filter, update, options });
      return { ...cfg };
    },
  };
  const service = createWorldEventReminderSchedulerService({
    GuildConfig,
    getAnnouncementsConfig: (doc) => doc.announcements,
    getGuildLanguage: async () => "en",
    postChannelAnnouncement: async () => null,
    t: (key) => key,
    nowDate: () => now,
  });
  const client = {
    guilds: {
      cache: new Map([["guild-1", makeGuild({})]]),
    },
  };

  await service.runWorldEventReminderTick(client);

  assert.equal(mutations.length, 2);
  const reminderKey = mutations[0].update.$set.lastWorldEventReminderKey;
  assert.deepEqual(mutations[1], {
    filter: { guildId: "guild-1", lastWorldEventReminderKey: reminderKey },
    update: { $set: { lastWorldEventReminderKey: null } },
    options: { returnDocument: "after" },
  });
});

test("the reminder post clears one minute after the spawn and its copy says how long", async () => {
  // Fri Nov 6 2026, 20 minutes before the 11:00 EST Field Boss.
  const now = utc(2026, 11, 6, 15, 40);
  const cfg = {
    guildId: "guild-1",
    raidChannelId: null,
    lastWorldEventReminderKey: null,
    announcements: {
      worldEventReminder: { enabled: true, channelId: "override-1" },
    },
  };
  const posts = [];
  const service = createWorldEventReminderSchedulerService({
    GuildConfig: {
      find: () => ({ lean: async () => [cfg] }),
      findOneAndUpdate: async () => ({ ...cfg }),
    },
    getAnnouncementsConfig: (doc) => doc.announcements,
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async (...args) => {
      posts.push(args);
      return { id: "message-1" };
    },
    t,
    nowDate: () => now,
  });

  await service.runWorldEventReminderTick({
    guilds: { cache: new Map([["guild-1", makeGuild({ id: "override-1" })]]) },
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0][2], 21 * 60 * 1000);
  assert.match(posts[0][1], /Field Boss/);
  assert.doesNotMatch(posts[0][1], /Chaos Gate/);
  assert.match(posts[0][1], /sau 21 phút/);
});

test("/raid-announce show describes the reminder with its real lead and clear-up time", () => {
  const entry = announcementTypeEntry("world-event-reminder");

  assert.match(entry.label, /T-20m/);
  assert.match(entry.trigger, /^20 phút trước /);
  assert.match(entry.dedup, /T-20m → T-0/);
  assert.match(entry.messageTtl, /^21 phút /);
  assert.match(entry.previewContent, /sau 20 phút/);
});
