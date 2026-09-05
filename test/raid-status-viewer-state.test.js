"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createStatusViewerStateLoader,
  loadStatusViewerState,
  probeLocalSyncMode,
  probeLocalSyncModeWithBudget,
} = require("../bot/handlers/raid-status/state/viewer-state");
const {
  clearUserLanguageCache,
  getUserLanguage,
} = require("../bot/services/i18n");
const {
  createRaidStatusSessionState,
} = require("../bot/handlers/raid-status/state/session-state");
const {
  buildRaidDropdownState,
  buildStatusRosterFilterEntries,
} = require("../bot/handlers/raid-status/raid-filter");

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

test("raid-status viewer loader reuses one lean seed for probe, language, and render state", async () => {
  clearUserLanguageCache();
  const seedDoc = {
    discordId: "user-1",
    language: "en",
    localSyncEnabled: true,
    accounts: [{ accountName: "Roster", characters: [] }],
  };
  let findOneCalls = 0;
  let leanCalls = 0;
  let shareCalls = 0;
  const User = {
    findOne(query) {
      findOneCalls += 1;
      assert.deepEqual(query, { discordId: "user-1" });
      return {
        async lean() {
          leanCalls += 1;
          return clone(seedDoc);
        },
      };
    },
  };
  const startBackgroundRefresh = () => Promise.resolve(null);
  const loader = createStatusViewerStateLoader({
    User,
    discordId: "user-1",
    prepareStatusUserDoc: (_discordId, doc) => ({
      userDoc: doc,
      piggybackOutcome: null,
      startBackgroundRefresh,
    }),
    getAccessibleAccountsFn: async () => {
      shareCalls += 1;
      return [];
    },
  });

  assert.equal(await loader.probeLocalSyncMode(), true);
  const state = await loader.load();
  assert.equal(state.lang, "en");
  assert.equal(state.userDoc.discordId, "user-1");
  assert.equal(findOneCalls, 1);
  assert.equal(leanCalls, 1);
  assert.equal(shareCalls, 1);

  assert.equal(
    await getUserLanguage("user-1", { UserModel: User }),
    "en",
    "the shared seed should also prime the process language cache"
  );
  assert.equal(findOneCalls, 1);
});

test("opening a new raid-status session reads a fresh DB snapshot", async () => {
  clearUserLanguageCache();
  let dbVersion = 1;
  let findOneCalls = 0;
  const User = {
    findOne() {
      findOneCalls += 1;
      return {
        async lean() {
          return {
            discordId: "user-reopen",
            language: "vi",
            localSyncEnabled: true,
            dbVersion,
            accounts: [{ accountName: "Roster", characters: [] }],
          };
        },
      };
    },
  };
  const createLoader = () => createStatusViewerStateLoader({
    User,
    discordId: "user-reopen",
    prepareStatusUserDoc: (_discordId, doc) => ({
      userDoc: doc,
      piggybackOutcome: null,
      startBackgroundRefresh: null,
    }),
    getAccessibleAccountsFn: async () => [],
  });

  const firstSession = await createLoader().load();
  dbVersion = 2;
  const reopenedSession = await createLoader().load();

  assert.equal(firstSession.userDoc.dbVersion, 1);
  assert.equal(reopenedSession.userDoc.dbVersion, 2);
  assert.equal(findOneCalls, 2, "each command invocation must create a new DB-backed snapshot");
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
    buildStatusRosterFilterEntries,
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

test("raid-status refreshes an aged interaction snapshot and skips a recent one", async () => {
  let nowMs = 1_000;
  let findOneCalls = 0;
  let dbDoc = {
    accounts: [{ accountName: "Roster", characters: [{ name: "A" }] }],
  };
  const state = await createRaidStatusSessionState({
    User: {
      findOne: async () => {
        findOneCalls += 1;
        return clone(dbDoc);
      },
    },
    discordId: "user-live",
    userDoc: clone(dbDoc),
    incomingSharedAccounts: [],
    buildMergedAccounts: async (_discordId, accounts) => accounts,
    getStatusRaidsForCharacter: () => [],
    buildRaidDropdownState: () => ({ raidDropdownEntries: [], totalRaidPending: 0 }),
    buildStatusRosterFilterEntries,
    now: () => nowMs,
    interactiveRefreshMaxAgeMs: 5_000,
  });

  nowMs += 4_999;
  assert.equal(await state.refreshViewerAccountsIfStale(), false);
  assert.equal(findOneCalls, 0);

  dbDoc = {
    accounts: [{
      accountName: "Roster",
      characters: [{ name: "A" }, { name: "B" }],
    }],
  };
  nowMs += 1;
  assert.equal(await state.refreshViewerAccountsIfStale(), true);
  assert.equal(findOneCalls, 1);
  assert.equal(state.totalCharacters, 2);
});

test("raid-status coalesces concurrent live snapshot reloads", async () => {
  let nowMs = 10_000;
  let findOneCalls = 0;
  let resolveFind;
  const findResult = new Promise((resolve) => {
    resolveFind = resolve;
  });
  const state = await createRaidStatusSessionState({
    User: {
      findOne: () => {
        findOneCalls += 1;
        return findResult;
      },
    },
    discordId: "user-coalesced",
    userDoc: { accounts: [{ accountName: "Roster", characters: [] }] },
    incomingSharedAccounts: [],
    buildMergedAccounts: async (_discordId, accounts) => accounts,
    getStatusRaidsForCharacter: () => [],
    buildRaidDropdownState: () => ({ raidDropdownEntries: [], totalRaidPending: 0 }),
    buildStatusRosterFilterEntries,
    now: () => nowMs,
    interactiveRefreshMaxAgeMs: 5_000,
  });

  nowMs += 5_000;
  const first = state.refreshViewerAccountsIfStale();
  const second = state.refreshViewerAccountsIfStale();
  assert.equal(first, second);
  assert.equal(findOneCalls, 1);

  resolveFind({ accounts: [{ accountName: "Roster", characters: [{ name: "Fresh" }] }] });
  assert.equal(await first, true);
  assert.equal(state.totalCharacters, 1);
});

test("raid-status starts fresh share authorization while its own roster reload is pending", async () => {
  let resolveOwn;
  const own = new Promise(resolve => { resolveOwn = resolve; });
  let shareReads = 0;
  const sharedAccount = { accountName: "Shared", characters: [], _sharedFrom: { ownerDiscordId: "owner" } };
  const state = await createRaidStatusSessionState({
    User: { findOne: () => own },
    discordId: "viewer",
    userDoc: { accounts: [] },
    incomingSharedAccounts: [],
    buildMergedAccounts: async (_id, accounts, options) => {
      if (options) return accounts;
      shareReads += 1;
      return [...accounts, sharedAccount];
    },
    getStatusRaidsForCharacter: () => [],
    buildRaidDropdownState: () => ({ raidDropdownEntries: [], totalRaidPending: 0 }),
    buildStatusRosterFilterEntries,
  });
  const reload = state.reloadViewerAccounts();
  try {
    assert.equal(shareReads, 1, "share authorization must not wait for the own-document query");
  } finally {
    resolveOwn({ accounts: [{ accountName: "Own", characters: [{ name: "Fresh" }] }] });
    await reload;
  }
  assert.deepEqual(state.accounts.map(account => account.accountName), ["Own", "Shared"]);
  assert.equal(state.accounts[1]._sharedFrom.ownerDiscordId, "owner");
  assert.equal(state.totalCharacters, 1);
});

test("raid-status session keeps roster dropdown and pagination synchronized", async () => {
  const accounts = [
    {
      accountName: "Alpha",
      characters: [{
        name: "A",
        raids: [{
          raidKey: "armoche",
          modeKey: "hard",
          raidName: "Act 4 Hard",
          goldReceives: true,
          isCompleted: false,
        }],
      }],
    },
    {
      accountName: "Beta",
      characters: [{
        name: "B",
        raids: [{
          raidKey: "kazeros",
          modeKey: "normal",
          raidName: "Kazeros Normal",
          goldReceives: true,
          isCompleted: false,
        }],
      }],
    },
    {
      accountName: "Gamma",
      characters: [{
        name: "C",
        raids: [{
          raidKey: "armoche",
          modeKey: "hard",
          raidName: "Act 4 Hard",
          goldReceives: true,
          isCompleted: true,
        }],
      }],
    },
  ];
  const state = await createRaidStatusSessionState({
    User: {},
    discordId: "user-1",
    userDoc: { accounts },
    incomingSharedAccounts: [],
    buildMergedAccounts: async (_discordId, ownAccounts) => ownAccounts,
    getStatusRaidsForCharacter: (character) => character.raids || [],
    buildRaidDropdownState,
    buildStatusRosterFilterEntries,
  });

  assert.deepEqual(state.visibleRosterIndices, [0, 1, 2]);
  assert.equal(state.selectedRosterIndex, null);

  state.movePage(1);
  assert.equal(state.currentPage, 1);
  assert.equal(state.selectedRosterIndex, 1);

  state.filterRaidId = "armoche:hard";
  assert.deepEqual(state.visibleRosterIndices, [0, 2]);
  assert.equal(state.currentPage, 0);
  assert.equal(state.currentLocalPage, 0);
  assert.equal(state.selectedRosterIndex, null);
  assert.deepEqual(
    state.rosterFilterEntries.map(({ pageIndex, pending, success }) => ({
      pageIndex,
      pending,
      success,
    })),
    [
      { pageIndex: 0, pending: 1, success: 0 },
      { pageIndex: 2, pending: 0, success: 1 },
    ]
  );

  state.movePage(1);
  assert.equal(state.currentPage, 2);
  assert.equal(state.currentLocalPage, 1);
  assert.equal(state.selectedRosterIndex, 2);

  state.selectRoster(null);
  assert.equal(state.currentPage, 0);
  assert.equal(state.selectedRosterIndex, null);

  state.selectRoster(2);
  assert.equal(state.currentPage, 2);
  assert.equal(state.selectedRosterIndex, 2);

  state.currentView = "task";
  assert.deepEqual(state.visibleRosterIndices, [0, 1, 2]);
  state.movePage(-1);
  assert.equal(state.currentPage, 1);

  state.currentView = "raid";
  assert.deepEqual(state.visibleRosterIndices, [0, 2]);
  assert.equal(state.currentPage, 0);
  assert.equal(state.selectedRosterIndex, null);
});

test("raid-status local-sync probe returns the saved localSyncEnabled flag", async () => {
  const User = makeUserModel({
    seedDoc: { discordId: "user-1", localSyncEnabled: true },
  });

  assert.equal(await probeLocalSyncMode({ User, discordId: "user-1" }), true);
});

test("raid-status local-sync probe fails closed to an ephemeral reply on read errors", async () => {
  const User = {
    findOne() {
      return {
        select: () => ({
          lean: async () => {
            throw new Error("temporary Mongo read failure");
          },
        }),
      };
    },
  };

  assert.equal(
    await probeLocalSyncMode({ User, discordId: "user-1" }),
    true,
    "an uncertain privacy mode must never fall back to a public signed-link surface"
  );
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
