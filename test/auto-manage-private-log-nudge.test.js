const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PRIVATE_LOG_NUDGE_TTL_MS,
  PRIVATE_LOG_NUDGE_DEDUP_MS,
  createPrivateLogNudgeService,
} = require("../bot/services/raid/schedulers/auto-manage-private-log-nudge");

class FakeButtonBuilder {
  constructor() {
    this.data = {};
  }
  setCustomId(value) {
    this.data.customId = value;
    return this;
  }
  setLabel(value) {
    this.data.label = value;
    return this;
  }
  setEmoji(value) {
    this.data.emoji = value;
    return this;
  }
  setStyle(value) {
    this.data.style = value;
    return this;
  }
}

class FakeActionRowBuilder {
  constructor() {
    this.components = [];
  }
  addComponents(...components) {
    this.components.push(...components);
    return this;
  }
}

function createUserModel(userDoc) {
  const updates = [];
  const calls = { findOne: 0, findOneAndUpdate: 0 };
  return {
    updates,
    calls,
    findOne() {
      calls.findOne += 1;
      return {
        select() {
          return {
            lean: async () => userDoc,
          };
        },
      };
    },
    async findOneAndUpdate(query, update) {
      calls.findOneAndUpdate += 1;
      updates.push({ query, update });
    },
  };
}

function createGuildConfig(configs) {
  const calls = { find: 0 };
  return {
    calls,
    find(query) {
      calls.find += 1;
      return {
        lean: async () => {
          calls.query = query;
          return configs;
        },
      };
    },
  };
}

function createGuild({ memberIds, channels }) {
  return {
    members: {
      cache: {
        has: (id) => memberIds.includes(id),
      },
    },
    channels: {
      cache: new Map(channels.map((channel) => [channel.id, channel])),
      fetch: async (id) => channels.find((channel) => channel.id === id) || null,
    },
  };
}

function createService({ User, GuildConfig, posts, nowMs = () => 1_000_000 } = {}) {
  return createPrivateLogNudgeService({
    User,
    GuildConfig,
    getAnnouncementsConfig: (cfg) => cfg.announcements,
    getUserLanguage: async () => "en",
    t: (key, lang, vars = {}) => `${key}:${lang}:${vars.discordId || ""}`,
    nowMs,
    discordComponents: {
      ActionRowBuilder: FakeActionRowBuilder,
      ButtonBuilder: FakeButtonBuilder,
      ButtonStyle: { Primary: "primary" },
    },
    postChannelAnnouncement: async (...args) => {
      posts.push(args);
      return { id: "sent" };
    },
  });
}

test("private-log nudge posts in the first reachable enabled guild and stamps dedup", async () => {
  const posts = [];
  const User = createUserModel({ lastPrivateLogNudgeAt: 0 });
  const GuildConfig = createGuildConfig([
    {
      guildId: "guild-1",
      raidChannelId: "monitor",
      announcements: {
        stuckPrivateLogNudge: { enabled: true, channelId: "override" },
      },
    },
  ]);
  const overrideChannel = { id: "override" };
  const client = {
    guilds: {
      cache: new Map([
        [
          "guild-1",
          createGuild({
            memberIds: ["user-1"],
            channels: [overrideChannel],
          }),
        ],
      ]),
    },
  };

  const service = createService({ User, GuildConfig, posts, nowMs: () => 12345 });
  await service.nudgeStuckPrivateLogUser(client, "user-1");

  assert.equal(posts.length, 1);
  const [channel, content, ttlMs, logTag, components] = posts[0];
  assert.equal(channel, overrideChannel);
  assert.equal(content, "announcements.stuck-nudge.body:en:user-1");
  assert.equal(ttlMs, PRIVATE_LOG_NUDGE_TTL_MS);
  assert.equal(logTag, "auto-manage private-log nudge");
  assert.equal(components[0].components[0].data.customId, "stuck-nudge:switch-to-local:user-1");
  assert.equal(components[0].components[0].data.label, "announcements.stuck-nudge.switchButtonLabel:en:");
  assert.equal(components[0].components[0].data.emoji, "\u{1F310}");
  assert.equal(components[0].components[0].data.style, "primary");
  assert.deepEqual(User.updates, [
    {
      query: { discordId: "user-1" },
      update: { $set: { lastPrivateLogNudgeAt: 12345 } },
    },
  ]);
});

test("private-log nudge respects the 7-day user dedup before querying guild config", async () => {
  const posts = [];
  const now = 12345;
  const User = createUserModel({
    lastPrivateLogNudgeAt: now - PRIVATE_LOG_NUDGE_DEDUP_MS + 1,
  });
  const GuildConfig = createGuildConfig([]);
  const service = createService({ User, GuildConfig, posts, nowMs: () => now });

  await service.nudgeStuckPrivateLogUser({ guilds: { cache: new Map() } }, "user-1");

  assert.equal(User.calls.findOne, 1);
  assert.equal(GuildConfig.calls.find, 0);
  assert.equal(posts.length, 0);
  assert.equal(User.calls.findOneAndUpdate, 0);
});
