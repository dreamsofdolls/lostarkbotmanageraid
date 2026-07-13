"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTO_MANAGE_DAILY_BATCH_SIZE,
  buildAutoManageDailyCandidateQuery,
  buildAutoManageDailyClaimQuery,
  createAutoManageDailySchedulerService,
  shouldNudgePrivateLogUser,
} = require("../bot/services/raid/schedulers/auto-manage-daily-scheduler");
const {
  getAutoManageDailyContext,
  markRaidStatusOpenedDay,
} = require("../bot/services/auto-manage/runtime/support/daily-backfill");

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

test("auto-manage daily scheduler selects users absent on the target VN day", () => {
  const dailyContext = {
    currentDayKey: "2026-07-14",
    targetDayKey: "2026-07-13",
  };
  const query = buildAutoManageDailyCandidateQuery(dailyContext);

  assert.deepEqual(query, {
    autoManageEnabled: true,
    localSyncEnabled: { $ne: true },
    "accounts.0": { $exists: true },
    lastRaidStatusOpenedDayKey: {
      $nin: ["2026-07-13", "2026-07-14"],
    },
    lastAutoManageDailyAttemptDayKey: { $ne: "2026-07-13" },
  });
  assert.deepEqual(buildAutoManageDailyClaimQuery("100", dailyContext), {
    discordId: "100",
    ...query,
  });
});

test("auto-manage daily context rolls over at midnight Asia/Ho_Chi_Minh", () => {
  assert.deepEqual(
    getAutoManageDailyContext(new Date("2026-07-13T16:59:59.000Z")),
    {
      currentDayKey: "2026-07-13",
      targetDayKey: "2026-07-12",
    }
  );
  assert.deepEqual(
    getAutoManageDailyContext(new Date("2026-07-13T17:00:00.000Z")),
    {
      currentDayKey: "2026-07-14",
      targetDayKey: "2026-07-13",
    }
  );
});

test("raid-status activity stamp writes the VN day key idempotently", async () => {
  const calls = [];
  const dayKey = await markRaidStatusOpenedDay({
    User: {
      updateOne: async (query, update) => calls.push({ query, update }),
    },
    discordId: "100",
    now: new Date("2026-07-13T17:05:00.000Z"),
  });

  assert.equal(dayKey, "2026-07-14");
  assert.deepEqual(calls, [
    {
      query: {
        discordId: "100",
        lastRaidStatusOpenedDayKey: { $ne: "2026-07-14" },
      },
      update: {
        $set: { lastRaidStatusOpenedDayKey: "2026-07-14" },
      },
    },
  ]);

  await markRaidStatusOpenedDay({
    User: {
      updateOne: async () => {
        throw new Error("same-day status open should reuse the loaded day key");
      },
    },
    discordId: "100",
    lastOpenedDayKey: "2026-07-14",
    now: new Date("2026-07-13T18:05:00.000Z"),
  });
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
    isPublicLogDisabledError: () => false,
    stampAutoManageAttempt: async () => {},
    nudgeStuckPrivateLogUser: async () => {},
    processEnv: { AUTO_MANAGE_DAILY_DISABLED: "true" },
  });

  await service.runAutoManageDailyTick({});

  assert.equal(findCalls, 0);
});

test("auto-manage daily scheduler syncs one absent user and releases the slot", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);
  try {
    const savedDocs = [];
    const releases = [];
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
    const claims = [];
    const User = {
      find: createFindChain([{ discordId: "100" }], (query) => {
        querySeen = query;
      }),
      findOne: async () => findOneDocs.shift() || null,
      updateOne: async (query, update) => {
        claims.push({ query, update });
        return { modifiedCount: 1 };
      },
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
      isPublicLogDisabledError: () => false,
      stampAutoManageAttempt: async () => {
        throw new Error("stamp fallback should not run on success");
      },
      nudgeStuckPrivateLogUser: async () => {
        throw new Error("nudge should not run on successful public logs");
      },
      processEnv: {},
    });

    await service.runAutoManageDailyTick(
      { clientId: "bot" },
      new Date("2026-07-13T17:05:00.000Z")
    );

    assert.equal(querySeen.autoManageEnabled, true);
    assert.deepEqual(querySeen.lastRaidStatusOpenedDayKey, {
      $nin: ["2026-07-13", "2026-07-14"],
    });
    assert.equal(claims.length, 1);
    assert.equal(
      claims[0].update.$set.lastAutoManageDailyAttemptDayKey,
      "2026-07-13"
    );
    assert.equal(savedDocs.length, 1);
    assert.equal(typeof savedDocs[0].lastAutoManageAttemptAt, "number");
    assert.equal(typeof savedDocs[0].lastAutoManageSyncAt, "number");
    assert.deepEqual(releases, ["100"]);
    assert.match(logs[0], /1 candidate\(s\).*synced 1/);
  } finally {
    console.log = originalLog;
  }
});

test("auto-manage daily scheduler skips a candidate claimed or opened after scan", async () => {
  let gatherCalls = 0;
  const releases = [];
  const service = createAutoManageDailySchedulerService({
    User: {
      find: createFindChain([{ discordId: "100" }]),
      findOne: async () => ({
        discordId: "100",
        autoManageEnabled: true,
        accounts: [{ accountName: "Main" }],
      }),
      updateOne: async () => ({ modifiedCount: 0 }),
    },
    saveWithRetry: async (fn) => fn(),
    ensureFreshWeek: () => {},
    weekResetStartMs: () => 0,
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: (discordId) => releases.push(discordId),
    gatherAutoManageLogsForUserDoc: async () => {
      gatherCalls += 1;
      return {};
    },
    applyAutoManageCollected: () => ({ perChar: [] }),
    isPublicLogDisabledError: () => false,
    stampAutoManageAttempt: async () => {},
    nudgeStuckPrivateLogUser: async () => {},
    processEnv: {},
  });

  await service.runAutoManageDailyTick(
    {},
    new Date("2026-07-13T17:05:00.000Z")
  );

  assert.equal(gatherCalls, 0);
  assert.deepEqual(releases, ["100"]);
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
