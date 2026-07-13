"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadStatusViewerState,
  probeLocalSyncMode,
  probeLocalSyncModeWithBudget,
} = require("../bot/handlers/raid-status/state/viewer-state");
const {
  clearUserLanguageCache,
} = require("../bot/services/i18n");
const {
  createRaidStatusSessionState,
} = require("../bot/handlers/raid-status/state/session-state");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeUserModel({ seedDoc = null, language = "vi" } = {}) {
  const calls = [];
  return {
    calls,
    findOne(query, projection) {
      calls.push({ query, projection });
      const result = projection && Object.prototype.hasOwnProperty.call(projection, "language")
        ? { language }
        : seedDoc;
      return {
        lean: async () => clone(result),
        select: () => ({ lean: async () => clone(result) }),
        then(resolve, reject) {
          return Promise.resolve(clone(result)).then(resolve, reject);
        },
      };
    },
  };
}

test("raid-status viewer state returns noRoster when viewer has no own or shared roster", async () => {
  clearUserLanguageCache();
  const User = makeUserModel({ seedDoc: null });

  const state = await loadStatusViewerState({
    User,
    discordId: "user-1",
    prepareStatusUserDoc: () => {
      throw new Error("own roster preparation should not run");
    },
    getAccessibleAccountsFn: async () => [],
  });

  assert.equal(state.noRoster, true);
  assert.equal(state.hasIncomingShare, false);
  assert.equal(state.userDoc, null);
});

test("raid-status viewer state supports share-only viewers with a stub user doc", async () => {
  clearUserLanguageCache();
  const User = makeUserModel({ seedDoc: null });
  const shared = [{ accountName: "Shared", characters: [{ name: "A" }] }];

  const state = await loadStatusViewerState({
    User,
    discordId: "viewer",
    prepareStatusUserDoc: () => {
      throw new Error("own roster preparation should not run");
    },
    getAccessibleAccountsFn: async () => shared,
  });

  assert.equal(state.noRoster, false);
  assert.equal(state.hasIncomingShare, true);
  assert.equal(state.incomingSharedAccounts, shared);
  assert.deepEqual(state.userDoc, { discordId: "viewer", accounts: [] });
});

test("raid-status viewer state returns the render snapshot without starting refresh", async () => {
  clearUserLanguageCache();
  const seedDoc = {
    discordId: "user-1",
    accounts: [{ accountName: "Roster", characters: [] }],
  };
  const User = makeUserModel({ seedDoc });
  let prepared = 0;
  let refreshStarted = 0;
  const startBackgroundRefresh = () => {
    refreshStarted += 1;
    return Promise.resolve({ userDoc: seedDoc, piggybackOutcome: null });
  };

  const state = await loadStatusViewerState({
    User,
    discordId: "user-1",
    prepareStatusUserDoc: (_discordId, doc) => {
      prepared += 1;
      assert.deepEqual(doc, seedDoc);
      return {
        userDoc: { ...seedDoc, prepared: true },
        piggybackOutcome: { outcome: "not-applicable", newGatesApplied: 0 },
        startBackgroundRefresh,
      };
    },
    getAccessibleAccountsFn: async () => [],
  });

  assert.equal(prepared, 1);
  assert.equal(refreshStarted, 0);
  assert.equal(state.userDoc.prepared, true);
  assert.equal(state.startBackgroundRefresh, startBackgroundRefresh);
});

test("raid-status session recounts characters after background roster refresh", async () => {
  const buildMergedAccounts = async (_discordId, accounts) => accounts;
  const state = await createRaidStatusSessionState({
    User: {},
    discordId: "user-1",
    userDoc: {
      accounts: [{ accountName: "Roster", characters: [{ name: "A" }] }],
    },
    incomingSharedAccounts: [],
    buildMergedAccounts,
    getStatusRaidsForCharacter: () => [],
    buildRaidDropdownState: () => ({
      raidDropdownEntries: [],
      totalRaidPending: 0,
    }),
  });

  assert.equal(state.totalCharacters, 1);
  await state.reloadViewerAccounts({
    accounts: [
      {
        accountName: "Roster",
        characters: [{ name: "A" }, { name: "B" }, { name: "C" }],
      },
    ],
  });
  assert.equal(state.totalCharacters, 3);
});

test("raid-status local-sync probe returns the saved localSyncEnabled flag", async () => {
  const User = makeUserModel({
    seedDoc: { discordId: "user-1", localSyncEnabled: true },
  });

  assert.equal(await probeLocalSyncMode({ User, discordId: "user-1" }), true);
});

test("raid-status local-sync probe times out safe-ephemeral before Discord ack deadline", async () => {
  const warnings = [];
  const User = {
    findOne() {
      return {
        select: () => ({ lean: () => new Promise(() => {}) }),
      };
    },
  };
  const waitWithBudget = (_promise, budgetMs) =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ timedOut: true, value: null }), budgetMs)
    );

  const result = await probeLocalSyncModeWithBudget({
    User,
    discordId: "user-1",
    waitWithBudget,
    budgetMs: 5,
    log: { warn: (message) => warnings.push(message) },
  });

  assert.equal(result, true);
  assert.match(warnings[0], /local-sync probe exceeded 5ms/);
});
