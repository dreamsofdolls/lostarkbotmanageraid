"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidStatusSync,
} = require("../bot/handlers/raid-status/sync/sync");
const {
  createAutoManageSyncService,
} = require("../bot/services/auto-manage/runtime/sync");

function createSync(overrides = {}) {
  return createRaidStatusSync({
    User: {
      findOne: async () => {
        throw new Error("fresh read path must not query Mongo again");
      },
    },
    saveWithRetry: async (operation) => operation(),
    ensureFreshWeek: () => false,
    collectStaleAccountRefreshes: async () => [],
    applyStaleAccountRefreshes: () => false,
    waitWithBudget: async (promise) => ({ timedOut: false, value: await promise }),
    acquireAutoManageSyncSlot: async () => ({ acquired: false }),
    releaseAutoManageSyncSlot: () => {},
    gatherAutoManageLogsForUserDoc: async () => null,
    applyAutoManageCollected: () => ({ perChar: [] }),
    commitAutoManageCollected: async () => ({
      status: "attempt-stamped",
      report: null,
      snapshot: null,
    }),
    applyAutoManageCollectedForStatus: async () => {},
    stampAutoManageAttempt: async () => {},
    weekResetStartMs: () => 0,
    STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS: 2500,
    ...overrides,
  });
}

test("raid-status fresh snapshot reuses the seed document without another Mongo read", async () => {
  let saveAttempts = 0;
  const seedDoc = {
    discordId: "user-1",
    accounts: [{ accountName: "Roster", characters: [] }],
    autoManageEnabled: false,
    toObject: () => ({
      discordId: "user-1",
      accounts: [{ accountName: "Roster", characters: [] }],
      autoManageEnabled: false,
    }),
  };
  const sync = createSync({
    saveWithRetry: async (operation) => {
      saveAttempts += 1;
      return operation();
    },
  });

  const result = await sync.loadStatusUserDoc("user-1", seedDoc);

  assert.equal(saveAttempts, 0);
  assert.deepEqual(result.userDoc, seedDoc.toObject());
  assert.equal(result.piggybackOutcome.outcome, "not-applicable");
});

test("raid-status changed week still enters the retry write path", async () => {
  let mongoReads = 0;
  let saves = 0;
  const seedDoc = {
    discordId: "user-1",
    accounts: [{ accountName: "Roster", characters: [] }],
    autoManageEnabled: false,
  };
  const freshDoc = {
    ...seedDoc,
    save: async () => {
      saves += 1;
    },
    toObject: () => ({ ...seedDoc }),
  };
  const sync = createSync({
    User: {
      findOne: async () => {
        mongoReads += 1;
        return freshDoc;
      },
    },
    ensureFreshWeek: () => true,
  });

  const result = await sync.loadStatusUserDoc("user-1", seedDoc);

  assert.equal(mongoReads, 1);
  assert.equal(saves, 1);
  assert.deepEqual(result.userDoc, seedDoc);
});

test("raid-status prepares a fresh render copy and starts sync lazily once", async () => {
  let refreshCollections = 0;
  const seedDoc = {
    discordId: "user-1",
    weeklyResetKey: "old",
    accounts: [{ accountName: "Roster", characters: [] }],
    autoManageEnabled: false,
  };
  const sync = createSync({
    ensureFreshWeek: (doc) => {
      doc.weeklyResetKey = "fresh";
      return false;
    },
    collectStaleAccountRefreshes: async () => {
      refreshCollections += 1;
      return [];
    },
  });

  const prepared = sync.prepareStatusUserDoc("user-1", seedDoc);

  assert.equal(prepared.userDoc.weeklyResetKey, "fresh");
  assert.equal(seedDoc.weeklyResetKey, "old");
  assert.equal(refreshCollections, 0);

  const first = prepared.startBackgroundRefresh();
  const second = prepared.startBackgroundRefresh();
  assert.equal(first, second);
  await first;
  assert.equal(refreshCollections, 1);
});

test("raid-status manual sync stamps and saves a successful report", async () => {
  let mongoReads = 0;
  let saves = 0;
  let fallbackStamps = 0;
  let releases = 0;
  let acquiredCallbacks = 0;
  const seedDoc = {
    discordId: "user-1",
    accounts: [{ accountName: "Roster", characters: [] }],
    autoManageEnabled: true,
  };
  const freshDoc = {
    ...seedDoc,
    save: async () => {
      saves += 1;
    },
  };
  const renderedDoc = {
    ...seedDoc,
    lastAutoManageAttemptAt: "persisted",
    lastAutoManageSyncAt: "persisted",
  };
  freshDoc.toObject = () => renderedDoc;
  const User = {
    findOne: () => {
      mongoReads += 1;
      if (mongoReads === 1) return Promise.resolve(seedDoc);
      if (mongoReads === 2) return Promise.resolve(freshDoc);
      return { lean: async () => renderedDoc };
    },
  };
  const applyAutoManageCollected = () => ({
    perChar: [{ error: null, applied: ["gate-1"] }],
  });
  const { commitAutoManageCollected } = createAutoManageSyncService({
    User,
    saveWithRetry: async (operation) => operation(),
    ensureFreshWeek: () => false,
    applyAutoManageCollected,
  });
  const sync = createSync({
    User,
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {
      releases += 1;
    },
    gatherAutoManageLogsForUserDoc: async () => ({ collected: true }),
    applyAutoManageCollected,
    commitAutoManageCollected,
    stampAutoManageAttempt: async () => {
      fallbackStamps += 1;
    },
  });

  const result = await sync.runManualStatusSync("user-1", {
    onAcquired: async () => {
      acquiredCallbacks += 1;
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.outcome.outcome, "applied");
  assert.equal(result.outcome.newGatesApplied, 1);
  assert.equal(result.userDoc, renderedDoc);
  assert.equal(saves, 1);
  assert.equal(fallbackStamps, 0);
  assert.equal(releases, 1);
  assert.equal(acquiredCallbacks, 1);
  assert.equal(mongoReads, 2);
  assert.equal(freshDoc.lastAutoManageAttemptAt, freshDoc.lastAutoManageSyncAt);
  assert.ok(Number.isFinite(freshDoc.lastAutoManageAttemptAt));
});
