const test = require("node:test");
const assert = require("node:assert/strict");

const { createRaidSchedulerService } = require("../src/services/raid-schedulers");

function createServiceWithGuildConfig(GuildConfig) {
  return createRaidSchedulerService({
    GuildConfig,
    User: {},
    saveWithRetry: async (fn) => fn(),
    ensureFreshWeek: () => {},
    getAnnouncementsConfig: () => ({}),
    cleanupRaidChannelMessages: async () => ({ deleted: 0, skippedOld: 0 }),
    weekResetStartMs: () => 0,
    acquireAutoManageSyncSlot: async () => ({ acquired: false }),
    releaseAutoManageSyncSlot: () => {},
    gatherAutoManageLogsForUserDoc: async () => ({}),
    applyAutoManageCollected: () => ({ perChar: [] }),
    isPublicLogDisabledError: () => false,
    stampAutoManageAttempt: async () => {},
  });
}

test("startRaidChannelScheduler skips overlapping auto-cleanup ticks", async () => {
  const originalSetInterval = global.setInterval;
  const originalWarn = console.warn;
  let intervalFn = null;
  let releaseFind = null;
  let findCalls = 0;

  const blockedFind = new Promise((resolve) => {
    releaseFind = resolve;
  });
  const GuildConfig = {
    find: () => ({
      lean: () => {
        findCalls += 1;
        return blockedFind;
      },
    }),
  };

  global.setInterval = (fn, ms) => {
    intervalFn = fn;
    return { ms };
  };
  console.warn = () => {};

  try {
    const service = createServiceWithGuildConfig(GuildConfig);
    const handle = service.startRaidChannelScheduler({ guilds: { cache: new Map() } });

    assert.equal(handle.ms, service.AUTO_CLEANUP_TICK_MS);
    assert.equal(typeof intervalFn, "function");
    assert.equal(findCalls, 1, "initial run should start immediately");

    intervalFn();
    await Promise.resolve();
    assert.equal(findCalls, 1, "overlapping interval fire must not start a second DB scan");

    releaseFind([]);
    await Promise.resolve();
    await Promise.resolve();

    intervalFn();
    await Promise.resolve();
    assert.equal(findCalls, 2, "next interval after completion should run normally");
  } finally {
    global.setInterval = originalSetInterval;
    console.warn = originalWarn;
    if (releaseFind) releaseFind([]);
  }
});
