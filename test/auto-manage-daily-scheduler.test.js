"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTO_MANAGE_BACKGROUND_STALE_MS,
  AUTO_MANAGE_DAILY_BATCH_SIZE,
  AUTO_MANAGE_DAILY_CUTOFF_MS,
  buildAutoManageDailyCandidateQuery,
  createAutoManageDailySchedulerService,
  shouldNudgePrivateLogUser,
} = require("../bot/services/raid/schedulers/auto-manage-daily-scheduler");

function createFindChain(candidates, onQuery) {
  return (query) => {
    onQuery?.(query);
    const chain = {
      sortArg: null,
      limitArg: null,
      selectArg: null,
      sort(arg) {
        this.sortArg = arg;
        return this;
      },
      limit(arg) {
        this.limitArg = arg;
        return this;
      },
      select(arg) {
        this.selectArg = arg;
        return this;
      },
      async lean() {
        return candidates;
      },
    };
    return chain;
  };
}

test("auto-manage daily scheduler builds the stale opted-in user query", () => {
  const query = buildAutoManageDailyCandidateQuery(12345);

  assert.deepEqual(query, {
    autoManageEnabled: true,
    localSyncEnabled: { $ne: true },
    "accounts.0": { $exists: true },
    $or: [
      { lastAutoManageAttemptAt: null },
      { lastAutoManageAttemptAt: { $lte: 12345 } },
    ],
  });
});

test("auto-manage daily scheduler uses the shared background stale window", () => {
  assert.equal(AUTO_MANAGE_DAILY_CUTOFF_MS, AUTO_MANAGE_BACKGROUND_STALE_MS);
  assert.equal(AUTO_MANAGE_BACKGROUND_STALE_MS, 30 * 60 * 1000);
});

test("auto-manage daily scheduler skips DB work when deploy killswitch is on", async () => {
  let findCalls = 0;
  const service = createAutoManageDailySchedulerService({
    User: {
      find: () => {
        findCalls += 1;
        throw new Error("should not query");
      },
    },
    saveWithRetry: async (fn) => fn(),
    ensureFreshWeek: () => {},
    weekResetStartMs: () => 0,
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {},
    gatherAutoManageLogsForUserDoc: async () => ({}),
    applyAutoManageCollected: () => ({ perChar: [] }),
    syncRaidProfileFromBibleCollected: async () => null,
    isPublicLogDisabledError: () => false,
    stampAutoManageAttempt: async () => {},
    nudgeStuckPrivateLogUser: async () => {},
    processEnv: { AUTO_MANAGE_DAILY_DISABLED: "true" },
  });

  await service.runAutoManageDailyTick({});

  assert.equal(findCalls, 0);
});

test("auto-manage daily scheduler syncs one stale user and releases the slot", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);
  try {
    const savedDocs = [];
    const releases = [];
    const profileSyncs = [];
    const seedDoc = {
      discordId: "100",
      autoManageEnabled: true,
      accounts: [{ accountName: "Main" }],
    };
    const freshDoc = {
      discordId: "100",
      autoManageEnabled: true,
      accounts: [{ accountName: "Main" }],
      async save() {
        savedDocs.push({ ...this });
      },
      toObject() {
        return { discordId: this.discordId, accounts: this.accounts };
      },
    };
    const findOneDocs = [seedDoc, freshDoc];
    let querySeen = null;
    const User = {
      find: createFindChain([{ discordId: "100" }], (query) => {
        querySeen = query;
      }),
      findOne: async () => findOneDocs.shift() || null,
    };
    const service = createAutoManageDailySchedulerService({
      User,
      saveWithRetry: async (fn) => fn(),
      ensureFreshWeek: () => {},
      weekResetStartMs: () => 777,
      acquireAutoManageSyncSlot: async () => ({ acquired: true }),
      releaseAutoManageSyncSlot: (discordId) => releases.push(discordId),
      gatherAutoManageLogsForUserDoc: async () => ({ source: "bible" }),
      applyAutoManageCollected: () => ({
        perChar: [{ charName: "Qiylyn", applied: ["G1"] }],
      }),
      syncRaidProfileFromBibleCollected: async (payload) => {
        profileSyncs.push(payload);
      },
      isPublicLogDisabledError: () => false,
      stampAutoManageAttempt: async () => {
        throw new Error("stamp fallback should not run on success");
      },
      nudgeStuckPrivateLogUser: async () => {
        throw new Error("nudge should not run on successful public logs");
      },
      processEnv: {},
    });

    await service.runAutoManageDailyTick({ clientId: "bot" });

    assert.equal(querySeen.autoManageEnabled, true);
    assert.equal(savedDocs.length, 1);
    assert.equal(typeof savedDocs[0].lastAutoManageAttemptAt, "number");
    assert.equal(typeof savedDocs[0].lastAutoManageSyncAt, "number");
    assert.deepEqual(releases, ["100"]);
    assert.equal(profileSyncs.length, 1);
    assert.equal(profileSyncs[0].discordId, "100");
    assert.equal(profileSyncs[0].weekResetStart, 777);
    assert.match(logs[0], /1 candidate\(s\).*synced 1/);
  } finally {
    console.log = originalLog;
  }
});

test("auto-manage daily scheduler nudges only when every report entry is private-log blocked", () => {
  assert.equal(
    shouldNudgePrivateLogUser({
      report: {
        perChar: [
          { error: "Logs not enabled" },
          { error: "private" },
        ],
      },
      isPublicLogDisabledError: (error) => ["Logs not enabled", "private"].includes(error),
    }),
    true
  );

  assert.equal(
    shouldNudgePrivateLogUser({
      report: {
        perChar: [
          { error: "Logs not enabled" },
          { applied: ["G1"] },
        ],
      },
      isPublicLogDisabledError: (error) => error === "Logs not enabled",
    }),
    false
  );

  assert.equal(
    shouldNudgePrivateLogUser({
      report: { perChar: [] },
      isPublicLogDisabledError: () => true,
    }),
    false
  );
});

test("auto-manage daily scheduler exposes the batch size used by the query chain", () => {
  let chain = null;
  const User = {
    find: (query) => {
      chain = createFindChain([], () => {})(query);
      return chain;
    },
  };
  const service = createAutoManageDailySchedulerService({
    User,
    saveWithRetry: async (fn) => fn(),
    ensureFreshWeek: () => {},
    weekResetStartMs: () => 0,
    acquireAutoManageSyncSlot: async () => ({ acquired: false }),
    releaseAutoManageSyncSlot: () => {},
    gatherAutoManageLogsForUserDoc: async () => ({}),
    applyAutoManageCollected: () => ({ perChar: [] }),
    syncRaidProfileFromBibleCollected: async () => null,
    isPublicLogDisabledError: () => false,
    stampAutoManageAttempt: async () => {},
    nudgeStuckPrivateLogUser: async () => {},
    processEnv: {},
  });

  return service.runAutoManageDailyTick({}).then(() => {
    assert.equal(chain.limitArg, AUTO_MANAGE_DAILY_BATCH_SIZE);
    assert.equal(AUTO_MANAGE_DAILY_BATCH_SIZE, 6);
    assert.deepEqual(chain.sortArg, { lastAutoManageAttemptAt: 1 });
    assert.equal(chain.selectArg, "discordId");
  });
});
