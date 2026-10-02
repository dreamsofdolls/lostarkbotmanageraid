"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDailyRosterSummaryPipeline,
  buildUnfinishedRosterQuery,
  createDailyRosterAnnouncementService,
} = require("../bot/services/raid/schedulers/daily-roster-announcement");

const TARGET_DAY_KEY = "2026-10-02";

function makeGuildConfigCursor(configs, findQueries = [], lifecycle = null) {
  return {
    find(query) {
      findQueries.push(query);
      return {
        select() {
          return this;
        },
        lean() {
          return this;
        },
        cursor() {
          const cursor = (async function* stream() {
            for (const cfg of configs) yield cfg;
          })();
          cursor.close = async () => {
            if (lifecycle) lifecycle.closeCalls = (lifecycle.closeCalls || 0) + 1;
          };
          return cursor;
        },
      };
    },
  };
}

function makeClient(channelId = "channel-1", channel = { id: channelId }) {
  return {
    guilds: {
      cache: new Map([["guild-1", {
        channels: {
          cache: new Map([[channelId, channel]]),
          fetch: async () => null,
        },
      }]]),
    },
  };
}

function makeService({
  User,
  GuildConfig,
  posts = [],
  postResult = { id: "message-1" },
} = {}) {
  return createDailyRosterAnnouncementService({
    User,
    GuildConfig,
    getAnnouncementsConfig: (cfg) => cfg.announcements,
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async (...args) => {
      posts.push(args);
      return postResult;
    },
    t: (key, lang, vars) => `${key}:${lang}:${JSON.stringify(vars)}`,
  });
}

function completeUser(summary = {
  userCount: 3,
  rosterCount: 5,
  syncedCount: 1,
  settledCount: 1,
  retryExhaustedCount: 1,
}) {
  const existsQueries = [];
  const aggregatePipelines = [];
  return {
    existsQueries,
    aggregatePipelines,
    model: {
      async exists(query) {
        existsQueries.push(query);
        return null;
      },
      async aggregate(pipeline) {
        aggregatePipelines.push(pipeline);
        return [summary];
      },
    },
  };
}

test("daily roster completion waits while any registered user is unfinished", async () => {
  const lifecycle = { closeCalls: 0 };
  const User = {
    async exists(query) {
      assert.deepEqual(query, buildUnfinishedRosterQuery(TARGET_DAY_KEY));
      return { _id: "unfinished-user" };
    },
    async aggregate() {
      assert.fail("aggregate must wait until every registered user settles");
    },
  };
  const GuildConfig = makeGuildConfigCursor([{
    guildId: "guild-1",
    raidChannelId: "channel-1",
    lastDailyRosterSyncKey: null,
    announcements: {
      dailyRosterSync: { enabled: true, channelId: null },
    },
  }], [], lifecycle);
  const service = makeService({ User, GuildConfig });

  const result = await service.notifyDailyRosterSync(
    makeClient(),
    { targetDayKey: TARGET_DAY_KEY }
  );

  assert.deepEqual(result, { notifiedCount: 0, reason: "unfinished" });
  assert.equal(lifecycle.closeCalls, 1, "early exit must close the guild cursor");
});

test("a completed steady-state tick skips every User query when no guild remains", async () => {
  let existsCalls = 0;
  let aggregateCalls = 0;
  const User = {
    async exists() {
      existsCalls += 1;
      return null;
    },
    async aggregate() {
      aggregateCalls += 1;
      return [];
    },
  };
  const GuildConfig = makeGuildConfigCursor([]);
  const service = makeService({ User, GuildConfig });

  const result = await service.notifyDailyRosterSync(
    makeClient(),
    { targetDayKey: TARGET_DAY_KEY }
  );

  assert.deepEqual(result, { notifiedCount: 0, reason: "no-target-guilds" });
  assert.equal(existsCalls, 0);
  assert.equal(aggregateCalls, 0);
});

test("an unresolvable configured channel skips every User query", async () => {
  let existsCalls = 0;
  let aggregateCalls = 0;
  const User = {
    async exists() {
      existsCalls += 1;
      return null;
    },
    async aggregate() {
      aggregateCalls += 1;
      return [];
    },
  };
  const GuildConfig = makeGuildConfigCursor([{
    guildId: "guild-1",
    raidChannelId: "missing-channel",
    lastDailyRosterSyncKey: null,
    announcements: {
      dailyRosterSync: { enabled: true, channelId: null },
    },
  }]);
  const service = makeService({ User, GuildConfig });

  const result = await service.notifyDailyRosterSync(
    makeClient("channel-1"),
    { targetDayKey: TARGET_DAY_KEY }
  );

  assert.deepEqual(result, { notifiedCount: 0, reason: "no-deliverable-guilds" });
  assert.equal(existsCalls, 0);
  assert.equal(aggregateCalls, 0);
});

test("daily roster summary counts users and rosters in Mongo instead of loading account arrays", async () => {
  const pipeline = buildDailyRosterSummaryPipeline(TARGET_DAY_KEY);
  assert.deepEqual(pipeline[0], {
    $match: {
      "accounts.0": { $exists: true },
      lastAutoManageDailyFinishedDayKey: TARGET_DAY_KEY,
    },
  });
  assert.deepEqual(pipeline[1].$group.rosterCount, {
    $sum: { $size: { $ifNull: ["$accounts", []] } },
  });
  assert.deepEqual(
    pipeline[1].$group.settledCount.$sum.$cond[0].$in[1],
    ["all-private", "no-actionable"]
  );
});

test("overlapping replicas claim once and post one aggregate completion", async () => {
  const userFixture = completeUser();
  let storedKey = null;
  let sends = 0;
  const cfg = {
    guildId: "guild-1",
    raidChannelId: "channel-1",
    lastDailyRosterSyncKey: null,
    announcements: {
      dailyRosterSync: { enabled: true, channelId: null },
    },
  };
  const GuildConfig = makeGuildConfigCursor([cfg]);
  GuildConfig.findOneAndUpdate = async (filter, update) => {
    if (filter.lastDailyRosterSyncKey?.$ne === TARGET_DAY_KEY) {
      if (storedKey === TARGET_DAY_KEY) return null;
      const previous = { ...cfg, lastDailyRosterSyncKey: storedKey };
      storedKey = update.$set.lastDailyRosterSyncKey;
      return previous;
    }
    return null;
  };
  const service = createDailyRosterAnnouncementService({
    User: userFixture.model,
    GuildConfig,
    getAnnouncementsConfig: (doc) => doc.announcements,
    getGuildLanguage: async () => "vi",
    postChannelAnnouncement: async () => {
      sends += 1;
      return { id: `message-${sends}` };
    },
    t: (key) => key,
  });

  await Promise.all([
    service.notifyDailyRosterSync(makeClient(), { targetDayKey: TARGET_DAY_KEY }),
    service.notifyDailyRosterSync(makeClient(), { targetDayKey: TARGET_DAY_KEY }),
  ]);

  assert.equal(sends, 1);
  assert.equal(storedKey, TARGET_DAY_KEY);
});

test("send failure rolls back the exact daily claim so a later tick can retry", async () => {
  const userFixture = completeUser();
  const mutations = [];
  const cfg = {
    guildId: "guild-1",
    raidChannelId: "channel-1",
    lastDailyRosterSyncKey: "2026-10-01",
    announcements: {
      dailyRosterSync: { enabled: true, channelId: null },
    },
  };
  const GuildConfig = makeGuildConfigCursor([cfg]);
  GuildConfig.findOneAndUpdate = async (filter, update, options) => {
    mutations.push({ filter, update, options });
    return { ...cfg };
  };
  const service = makeService({
    User: userFixture.model,
    GuildConfig,
    postResult: null,
  });

  await service.notifyDailyRosterSync(makeClient(), { targetDayKey: TARGET_DAY_KEY });

  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[1], {
    filter: {
      guildId: "guild-1",
      lastDailyRosterSyncKey: TARGET_DAY_KEY,
    },
    update: { $set: { lastDailyRosterSyncKey: "2026-10-01" } },
    options: { new: true },
  });
});

test("a channel config change invalidates the stale scan before it can claim", async () => {
  const userFixture = completeUser();
  const cfg = {
    guildId: "guild-1",
    raidChannelId: "channel-1",
    lastDailyRosterSyncKey: null,
    announcements: {
      dailyRosterSync: { enabled: true, channelId: "channel-1" },
    },
  };
  let claimFilter = null;
  const GuildConfig = makeGuildConfigCursor([cfg]);
  GuildConfig.findOneAndUpdate = async (filter) => {
    claimFilter = filter;
    return null;
  };
  const posts = [];
  const service = makeService({ User: userFixture.model, GuildConfig, posts });

  const result = await service.notifyDailyRosterSync(
    makeClient(),
    { targetDayKey: TARGET_DAY_KEY }
  );

  assert.equal(result.notifiedCount, 0);
  assert.equal(claimFilter.raidChannelId, "channel-1");
  assert.equal(
    claimFilter["announcements.dailyRosterSync.channelId"],
    "channel-1"
  );
  assert.equal(posts.length, 0);
});

test("disabled daily roster announcements are skipped without a claim", async () => {
  const userFixture = completeUser();
  const cfg = {
    guildId: "guild-1",
    raidChannelId: "channel-1",
    lastDailyRosterSyncKey: null,
    announcements: {
      dailyRosterSync: { enabled: false, channelId: null },
    },
  };
  let claimed = false;
  const GuildConfig = makeGuildConfigCursor([cfg]);
  GuildConfig.findOneAndUpdate = async () => {
    claimed = true;
    return cfg;
  };
  const service = makeService({ User: userFixture.model, GuildConfig });

  await service.notifyDailyRosterSync(makeClient(), { targetDayKey: TARGET_DAY_KEY });

  assert.equal(claimed, false);
});
