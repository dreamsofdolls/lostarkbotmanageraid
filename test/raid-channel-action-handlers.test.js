const test = require("node:test");
const assert = require("node:assert/strict");

const { EmbedBuilder } = require("discord.js");
const { UI } = require("../bot/utils/raid/common/shared");
const {
  createRaidChannelCoreActions,
} = require("../bot/handlers/raid/channel/core-actions");
const {
  createRaidChannelLanguageActions,
} = require("../bot/handlers/raid/channel/language-actions");
const {
  createRaidChannelScheduleActions,
} = require("../bot/handlers/raid/channel/schedule-actions");

function t(key, lang, vars = {}) {
  return `${lang}:${key}${vars.lang ? `:${vars.lang}` : ""}${vars.label ? `:${vars.label}` : ""}`;
}

function makeReplyCollectors() {
  return {
    embeds: [],
    notices: [],
    replyChannelEmbed(embed) {
      this.embeds.push(embed.toJSON());
    },
    replyChannelNotice(notice) {
      this.notices.push(notice);
    },
  };
}

function createCoreActions(overrides = {}) {
  return createRaidChannelCoreActions({
    EmbedBuilder,
    UI,
    GuildConfig: {
      findOneAndUpdate: async () => {},
      findOne: () => ({
        select() {
          return this;
        },
        lean: async () => ({}),
      }),
    },
    getCachedMonitorChannelId: () => "chan1",
    setCachedMonitorChannelId: () => {},
    getMonitorCacheHealth: () => ({ healthy: true }),
    isTextMonitorEnabled: () => true,
    getMissingBotChannelPermissions: () => [],
    postRaidChannelWelcome: async () => ({ posted: true, pinned: true, removedOldCount: 0 }),
    postChannelAnnouncement: async () => {},
    getAnnouncementsConfig: () => ({ setGreeting: { enabled: true } }),
    resolveRaidMonitorChannel: async () => ({ id: "chan1" }),
    cleanupRaidChannelMessages: async () => ({ deleted: 0, skippedOld: 0 }),
    getGuildLanguage: async () => "vi",
    SUPPORTED_LANGUAGES: [{ code: "vi", flag: "VI", label: "Vietnamese" }],
    t,
    ...overrides,
  });
}

test("raid-channel clear action resets monitor channel and schedule state", async () => {
  const updates = [];
  const cacheWrites = [];
  const replies = makeReplyCollectors();
  const { handleClearChannel } = createCoreActions({
    GuildConfig: {
      findOneAndUpdate: async (...args) => updates.push(args),
    },
    setCachedMonitorChannelId: (...args) => cacheWrites.push(args),
  });

  await handleClearChannel({
    guildId: "guild1",
    lang: "en",
    replyChannelEmbed: replies.replyChannelEmbed.bind(replies),
  });

  assert.deepEqual(updates[0][0], { guildId: "guild1" });
  assert.deepEqual(updates[0][1], {
    $set: { raidChannelId: null, autoCleanupEnabled: false },
  });
  assert.deepEqual(cacheWrites[0], ["guild1", null]);
  assert.equal(replies.embeds.length, 1);
});

test("raid-channel cleanup action warns before deferring when no monitor channel exists", async () => {
  let deferred = false;
  const replies = makeReplyCollectors();
  const { handleCleanupChannel } = createCoreActions({
    getCachedMonitorChannelId: () => null,
    resolveRaidMonitorChannel: async () => {
      throw new Error("should not resolve channel");
    },
    cleanupRaidChannelMessages: async () => {
      throw new Error("should not cleanup");
    },
  });

  await handleCleanupChannel({
    interaction: {
      deferReply: async () => {
        deferred = true;
      },
    },
    guildId: "guild1",
    lang: "en",
    replyChannelNotice: replies.replyChannelNotice.bind(replies),
    editChannelEmbed: replies.replyChannelEmbed.bind(replies),
    editChannelNotice: replies.replyChannelNotice.bind(replies),
  });

  assert.equal(deferred, false);
  assert.equal(replies.notices.length, 1);
  assert.equal(replies.notices[0].type, "warn");
});

test("raid-channel schedule action rejects redundant no-op toggles", async () => {
  const updates = [];
  const replies = makeReplyCollectors();
  const GuildConfig = {
    findOne: () => ({ lean: async () => ({ autoCleanupEnabled: true }) }),
    findOneAndUpdate: async (...args) => updates.push(args),
  };
  const { handleScheduleToggle } = createRaidChannelScheduleActions({
    EmbedBuilder,
    UI,
    GuildConfig,
    getCachedMonitorChannelId: () => "chan1",
    getTargetCleanupSlotKey: () => "slot-key",
    t,
  });

  await handleScheduleToggle({
    action: "schedule-on",
    guildId: "guild1",
    lang: "en",
    replyChannelEmbed: replies.replyChannelEmbed.bind(replies),
    replyChannelNotice: replies.replyChannelNotice.bind(replies),
  });

  assert.equal(updates.length, 0);
  assert.equal(replies.notices.length, 1);
  assert.equal(replies.notices[0].type, "info");
});

test("raid-channel schedule action requires a monitor channel before enabling", async () => {
  const updates = [];
  const replies = makeReplyCollectors();
  const GuildConfig = {
    findOne: () => ({ lean: async () => ({ autoCleanupEnabled: false }) }),
    findOneAndUpdate: async (...args) => updates.push(args),
  };
  const { handleScheduleToggle } = createRaidChannelScheduleActions({
    EmbedBuilder,
    UI,
    GuildConfig,
    getCachedMonitorChannelId: () => null,
    getTargetCleanupSlotKey: () => "slot-key",
    t,
  });

  await handleScheduleToggle({
    action: "schedule-on",
    guildId: "guild1",
    lang: "en",
    replyChannelEmbed: replies.replyChannelEmbed.bind(replies),
    replyChannelNotice: replies.replyChannelNotice.bind(replies),
  });

  assert.equal(updates.length, 0);
  assert.equal(replies.notices[0].type, "warn");
});

test("raid-channel schedule action enables schedule with a fresh slot key", async () => {
  const updates = [];
  const replies = makeReplyCollectors();
  const GuildConfig = {
    findOne: () => ({ lean: async () => ({ autoCleanupEnabled: false }) }),
    findOneAndUpdate: async (...args) => updates.push(args),
  };
  const { handleScheduleToggle } = createRaidChannelScheduleActions({
    EmbedBuilder,
    UI,
    GuildConfig,
    getCachedMonitorChannelId: () => "chan1",
    getTargetCleanupSlotKey: () => "slot-key",
    t,
  });

  await handleScheduleToggle({
    action: "schedule-on",
    guildId: "guild1",
    lang: "en",
    replyChannelEmbed: replies.replyChannelEmbed.bind(replies),
    replyChannelNotice: replies.replyChannelNotice.bind(replies),
  });

  assert.deepEqual(updates[0][0], { guildId: "guild1" });
  assert.deepEqual(updates[0][1], {
    $set: { autoCleanupEnabled: true, lastAutoCleanupKey: "slot-key" },
  });
  assert.equal(replies.embeds.length, 1);
});

test("raid-channel language action rejects invalid free text", async () => {
  const replies = makeReplyCollectors();
  const writes = [];
  const { handleSetLanguage } = createRaidChannelLanguageActions({
    EmbedBuilder,
    UI,
    GuildConfig: {},
    getGuildLanguage: async () => "vi",
    setGuildLanguage: async (...args) => writes.push(args),
    SUPPORTED_LANGUAGES: [{ code: "vi", flag: "VI", label: "Vietnamese" }],
    t,
  });

  await handleSetLanguage({
    interaction: { options: { getString: () => "xx" } },
    guildId: "guild1",
    lang: "en",
    replyChannelEmbed: replies.replyChannelEmbed.bind(replies),
    replyChannelNotice: replies.replyChannelNotice.bind(replies),
  });

  assert.equal(writes.length, 0);
  assert.equal(replies.notices[0].type, "warn");
});

test("raid-channel language action persists valid language and renders success in new locale", async () => {
  const replies = makeReplyCollectors();
  const writes = [];
  const languages = [
    { code: "vi", flag: "VI", label: "Vietnamese" },
    { code: "jp", flag: "JP", label: "Japanese" },
  ];
  const { handleSetLanguage } = createRaidChannelLanguageActions({
    EmbedBuilder,
    UI,
    GuildConfig: {},
    getGuildLanguage: async () => "vi",
    setGuildLanguage: async (...args) => writes.push(args),
    SUPPORTED_LANGUAGES: languages,
    t,
  });

  await handleSetLanguage({
    interaction: { options: { getString: () => "jp" } },
    guildId: "guild1",
    lang: "en",
    replyChannelEmbed: replies.replyChannelEmbed.bind(replies),
    replyChannelNotice: replies.replyChannelNotice.bind(replies),
  });

  assert.deepEqual(writes[0][0], "guild1");
  assert.deepEqual(writes[0][1], "jp");
  assert.match(replies.embeds[0].title, /jp:raid-channel-language\.successTitle/);
});
