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
    loadStatusUserDoc: async () => {
      throw new Error("own roster refresh should not run");
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
    loadStatusUserDoc: async () => {
      throw new Error("own roster refresh should not run");
    },
    getAccessibleAccountsFn: async () => shared,
  });

  assert.equal(state.noRoster, false);
  assert.equal(state.hasIncomingShare, true);
  assert.equal(state.incomingSharedAccounts, shared);
  assert.deepEqual(state.userDoc, { discordId: "viewer", accounts: [] });
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
