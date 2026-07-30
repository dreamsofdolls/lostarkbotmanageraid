"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTO_MANAGE_DAILY_BATCH_SIZE,
  buildAutoManageDailyCandidateQuery,
  buildAutoManageDailyClaimQuery,
  createAutoManageDailySchedulerService,
  persistTransientDailyFailure,
  shouldNudgePrivateLogUser,
} = require("../bot/services/raid/schedulers/auto-manage-daily-scheduler");
const {
  getAutoManageDailyContext,
  markRaidStatusOpenedDay,
} = require("../bot/services/auto-manage/runtime/support/daily-backfill");
const {
  AUTO_MANAGE_DAILY_LEASE_MS,
  AUTO_MANAGE_DAILY_RETRY_DELAYS_MS,
  AUTO_MANAGE_DAILY_OUTCOME,
} = require("../bot/services/auto-manage/runtime/support/daily-state");

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

test("auto-manage daily scheduler selects unfinished users without a status-open gate", () => {
  const dailyContext = {
    currentDayKey: "2026-07-14",
    targetDayKey: "2026-07-13",
  };
  const nowMs = Date.parse("2026-07-13T17:05:00.000Z");
  const query = buildAutoManageDailyCandidateQuery(dailyContext, nowMs);

  assert.deepEqual(query, {
    autoManageEnabled: true,
    localSyncEnabled: { $ne: true },
    "accounts.0": { $exists: true },
    lastAutoManageDailyFinishedDayKey: { $ne: "2026-07-13" },
    $and: [
      {
        $or: [
          { autoManageDailyLeaseUntil: { $exists: false } },
          { autoManageDailyLeaseUntil: null },
          { autoManageDailyLeaseUntil: { $lte: nowMs } },
        ],
      },
      {
        $or: [
          { lastAutoManageDailyAttemptDayKey: { $ne: "2026-07-13" } },
          { autoManageDailyNextAttemptAt: { $exists: false } },
          { autoManageDailyNextAttemptAt: null },
          { autoManageDailyNextAttemptAt: { $lte: nowMs } },
        ],
      },
    ],
  });
  assert.equal(JSON.stringify(query).includes("lastRaidStatusOpenedDayKey"), false);
  assert.deepEqual(buildAutoManageDailyClaimQuery("100", dailyContext, nowMs), {
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
      autoManageDailyLeaseDayKey: "2026-07-13",
      autoManageDailyAttemptCount: 1,
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
    assert.equal(
      JSON.stringify(querySeen).includes("lastRaidStatusOpenedDayKey"),
      false
    );
    assert.equal(claims.length, 1);
    assert.equal(
      claims[0].update.$set.lastAutoManageDailyAttemptDayKey,
      "2026-07-13"
    );
    assert.equal(claims[0].update.$set.autoManageDailyAttemptCount, 1);
    assert.equal(
      claims[0].update.$set.autoManageDailyLeaseUntil,
      Date.parse("2026-07-13T17:05:00.000Z") + AUTO_MANAGE_DAILY_LEASE_MS
    );
    assert.equal(savedDocs.length, 1);
    assert.equal(typeof savedDocs[0].lastAutoManageAttemptAt, "number");
    assert.equal(typeof savedDocs[0].lastAutoManageSyncAt, "number");
    assert.equal(
      savedDocs[0].lastAutoManageDailyFinishedDayKey,
      "2026-07-13"
    );
    assert.equal(
      savedDocs[0].lastAutoManageDailyOutcome,
      AUTO_MANAGE_DAILY_OUTCOME.success
    );
    assert.equal(savedDocs[0].autoManageDailyLeaseUntil, null);
    assert.deepEqual(releases, ["100"]);
    assert.match(logs[0], /1 candidate\(s\).*synced 1/);
  } finally {
    console.log = originalLog;
  }
});

test("auto-manage daily scheduler skips a candidate leased or finished after scan", async () => {
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

test("auto-manage daily scheduler schedules a transient report retry without finishing the day", async () => {
  const savedDocs = [];
  const seedDoc = {
    discordId: "100",
    autoManageEnabled: true,
    accounts: [{ accountName: "Main" }],
  };
  const freshDoc = {
    discordId: "100",
    autoManageEnabled: true,
    accounts: [{ accountName: "Main" }],
    autoManageDailyLeaseDayKey: "2026-07-13",
    autoManageDailyAttemptCount: 1,
    async save() {
      savedDocs.push({ ...this });
    },
  };
  const findOneDocs = [seedDoc, freshDoc];
  const service = createAutoManageDailySchedulerService({
    User: {
      find: createFindChain([{ discordId: "100" }]),
      findOne: async () => findOneDocs.shift() || null,
      updateOne: async () => ({ modifiedCount: 1 }),
    },
    saveWithRetry: async (fn) => fn(),
    ensureFreshWeek: () => {},
    weekResetStartMs: () => 777,
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {},
    gatherAutoManageLogsForUserDoc: async () => ({ source: "bible" }),
    applyAutoManageCollected: () => ({
      perChar: [{ charName: "Qiylyn", error: "HTTP 503", applied: [] }],
    }),
    isPublicLogDisabledError: () => false,
    nudgeStuckPrivateLogUser: async () => {
      throw new Error("transient failures must not post private-log nudges");
    },
    processEnv: {},
  });

  await service.runAutoManageDailyTick(
    {},
    new Date("2026-07-13T17:05:00.000Z")
  );

  assert.equal(savedDocs.length, 1);
  assert.equal(
    savedDocs[0].lastAutoManageDailyOutcome,
    AUTO_MANAGE_DAILY_OUTCOME.retryScheduled
  );
  assert.equal(
    savedDocs[0].autoManageDailyNextAttemptAt,
    Date.parse("2026-07-13T17:05:00.000Z") +
      AUTO_MANAGE_DAILY_RETRY_DELAYS_MS[0]
  );
  assert.equal(savedDocs[0].lastAutoManageDailyFinishedDayKey, undefined);
  assert.equal(savedDocs[0].autoManageDailyLeaseDayKey, "");
  assert.equal(savedDocs[0].autoManageDailyLeaseUntil, null);
});

test("auto-manage daily scheduler settles all-private reports and posts one nudge", async () => {
  const savedDocs = [];
  const nudges = [];
  const seedDoc = {
    discordId: "100",
    autoManageEnabled: true,
    accounts: [{ accountName: "Main" }],
  };
  const freshDoc = {
    discordId: "100",
    autoManageEnabled: true,
    accounts: [{ accountName: "Main" }],
    autoManageDailyLeaseDayKey: "2026-07-13",
    autoManageDailyAttemptCount: 1,
    async save() {
      savedDocs.push({ ...this });
    },
  };
  const findOneDocs = [seedDoc, freshDoc];
  const service = createAutoManageDailySchedulerService({
    User: {
      find: createFindChain([{ discordId: "100" }]),
      findOne: async () => findOneDocs.shift() || null,
      updateOne: async () => ({ modifiedCount: 1 }),
    },
    saveWithRetry: async (fn) => fn(),
    ensureFreshWeek: () => {},
    weekResetStartMs: () => 777,
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {},
    gatherAutoManageLogsForUserDoc: async () => ({ source: "bible" }),
    applyAutoManageCollected: () => ({
      perChar: [
        { charName: "Qiylyn", error: "Logs not enabled", applied: [] },
      ],
    }),
    isPublicLogDisabledError: (error) => error === "Logs not enabled",
    nudgeStuckPrivateLogUser: async (client, discordId) => {
      nudges.push({ client, discordId });
    },
    processEnv: {},
  });

  const client = { clientId: "bot" };
  await service.runAutoManageDailyTick(
    client,
    new Date("2026-07-13T17:05:00.000Z")
  );

  assert.equal(savedDocs.length, 1);
  assert.equal(
    savedDocs[0].lastAutoManageDailyFinishedDayKey,
    "2026-07-13"
  );
  assert.equal(
    savedDocs[0].lastAutoManageDailyOutcome,
    AUTO_MANAGE_DAILY_OUTCOME.allPrivate
  );
  assert.deepEqual(nudges, [{ client, discordId: "100" }]);
});

test("auto-manage daily scheduler persists retry state when gather throws", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const savedDocs = [];
    const seedDoc = {
      discordId: "100",
      autoManageEnabled: true,
      accounts: [{ accountName: "Main" }],
    };
    const retryDoc = {
      discordId: "100",
      autoManageEnabled: true,
      accounts: [{ accountName: "Main" }],
      autoManageDailyLeaseDayKey: "2026-07-13",
      autoManageDailyAttemptCount: 1,
      async save() {
        savedDocs.push({ ...this });
      },
    };
    const findOneDocs = [seedDoc, retryDoc];
    const service = createAutoManageDailySchedulerService({
      User: {
        find: createFindChain([{ discordId: "100" }]),
        findOne: async () => findOneDocs.shift() || null,
        updateOne: async () => ({ modifiedCount: 1 }),
      },
      saveWithRetry: async (fn) => fn(),
      ensureFreshWeek: () => {},
      weekResetStartMs: () => 777,
      acquireAutoManageSyncSlot: async () => ({ acquired: true }),
      releaseAutoManageSyncSlot: () => {},
      gatherAutoManageLogsForUserDoc: async () => {
        throw new Error("upstream unavailable");
      },
      applyAutoManageCollected: () => {
        throw new Error("apply must not run after gather failure");
      },
      isPublicLogDisabledError: () => false,
      nudgeStuckPrivateLogUser: async () => {},
      processEnv: {},
    });

    await service.runAutoManageDailyTick(
      {},
      new Date("2026-07-13T17:05:00.000Z")
    );

    assert.equal(savedDocs.length, 1);
    assert.equal(
      savedDocs[0].lastAutoManageDailyOutcome,
      AUTO_MANAGE_DAILY_OUTCOME.retryScheduled
    );
    assert.equal(
      savedDocs[0].autoManageDailyNextAttemptAt,
      Date.parse("2026-07-13T17:05:00.000Z") +
        AUTO_MANAGE_DAILY_RETRY_DELAYS_MS[0]
    );
    assert.match(warnings.join("\n"), /upstream unavailable/);
  } finally {
    console.warn = originalWarn;
  }
});

test("transient failure persistence respects configuration changes made during a claim", async () => {
  for (const {
    name,
    docOverrides,
    expectedOutcome,
  } of [
    {
      name: "auto-manage disabled",
      docOverrides: { autoManageEnabled: false },
      expectedOutcome: AUTO_MANAGE_DAILY_OUTCOME.disabled,
    },
    {
      name: "local sync enabled",
      docOverrides: { localSyncEnabled: true },
      expectedOutcome: AUTO_MANAGE_DAILY_OUTCOME.disabled,
    },
    {
      name: "roster removed",
      docOverrides: { accounts: [] },
      expectedOutcome: AUTO_MANAGE_DAILY_OUTCOME.noRoster,
    },
  ]) {
    const savedDocs = [];
    const freshDoc = {
      discordId: "100",
      autoManageEnabled: true,
      localSyncEnabled: false,
      accounts: [{ accountName: "Main" }],
      autoManageDailyLeaseDayKey: "2026-07-13",
      autoManageDailyLeaseUntil: Date.parse("2026-07-13T17:25:00.000Z"),
      autoManageDailyAttemptCount: 1,
      ...docOverrides,
      async save() {
        savedDocs.push({ ...this });
      },
    };

    const transition = await persistTransientDailyFailure({
      User: {
        findOne: async () => freshDoc,
      },
      saveWithRetry: async (fn) => fn(),
      discordId: "100",
      dailyContext: { targetDayKey: "2026-07-13" },
      attemptCount: 1,
      nowMs: Date.parse("2026-07-13T17:05:00.000Z"),
    });

    assert.equal(transition.bucket, "skipped", name);
    assert.equal(transition.outcome, expectedOutcome, name);
    assert.equal(savedDocs.length, 1, name);
    assert.equal(savedDocs[0].lastAutoManageDailyOutcome, expectedOutcome, name);
    assert.equal(savedDocs[0].autoManageDailyNextAttemptAt, null, name);
    assert.equal(savedDocs[0].autoManageDailyLeaseDayKey, "", name);
    assert.equal(savedDocs[0].autoManageDailyLeaseUntil, null, name);
    assert.equal(savedDocs[0].lastAutoManageDailyFinishedDayKey, undefined, name);
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
    isPublicLogDisabledError: () => false,
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
