"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidStatusSync,
} = require("../bot/handlers/raid-status/sync/sync");

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
