const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMonitorChannelCache,
} = require("../bot/services/raid/channel-monitor/channel-monitor-cache");

function createGuildConfig(configs, error = null) {
  return {
    find() {
      return {
        lean: async () => {
          if (error) throw error;
          return configs;
        },
      };
    },
  };
}

test("raid-channel monitor cache loads guild channel ids and exposes health", async () => {
  const cache = createMonitorChannelCache({
    GuildConfig: createGuildConfig([
      { guildId: "guild-a", raidChannelId: "chan-a" },
      { guildId: "guild-b", raidChannelId: null },
    ]),
  });

  const originalLog = console.log;
  console.log = () => {};
  try {
    await cache.loadMonitorChannelCache();
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(cache.getMonitorCacheHealth(), { healthy: true, error: null });
  assert.equal(cache.getCachedMonitorChannelId("guild-a"), "chan-a");
  assert.equal(cache.getCachedMonitorChannelId("guild-b"), null);
  assert.equal(cache.getCachedMonitorChannelId("missing"), null);

  cache.setCachedMonitorChannelId("guild-c", "chan-c");
  assert.equal(cache.getCachedMonitorChannelId("guild-c"), "chan-c");
});

test("raid-channel monitor cache records failed load state", async () => {
  const cache = createMonitorChannelCache({
    GuildConfig: createGuildConfig([], new Error("mongo down")),
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    await cache.loadMonitorChannelCache();
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(cache.getMonitorCacheHealth(), {
    healthy: false,
    error: "mongo down",
  });
});
