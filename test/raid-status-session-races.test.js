"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRaidStatusSessionState } = require("../bot/handlers/raid-status/state/session-state");
const { buildRaidDropdownState, buildStatusRosterFilterEntries } = require("../bot/handlers/raid-status/raid-filter");

const ownDoc = (version) => ({ discordId: "viewer", version,
  accounts: [{ accountName: "Own", characters: [{ name: `Character-${version}` }] }] });
const shared = { accountName: "Shared", characters: [{ name: "Shared character" }],
  _sharedFrom: { ownerDiscordId: "owner" } };

function createState({ readOwn, readShares = async () => [], now = Date.now }) {
  return createRaidStatusSessionState({
    User: { findOne: readOwn }, discordId: "viewer", userDoc: ownDoc(0),
    incomingSharedAccounts: [shared],
    buildMergedAccounts: async (_id, accounts, options) => [...accounts,
      ...(options ? options.accessibleAccounts : await readShares())],
    getStatusRaidsForCharacter: () => [], buildRaidDropdownState, buildStatusRosterFilterEntries, now,
  });
}

test("an older roster read cannot restore revoked shares or replace a newer saved snapshot", async () => {
  let resolveOwn, resolveShares;
  const oldOwn = new Promise(resolve => { resolveOwn = resolve; });
  const oldShares = new Promise(resolve => { resolveShares = resolve; });
  let ownReads = 0, shareReads = 0, nowMs = 0;
  const state = await createState({
    readOwn: () => ++ownReads === 1 ? oldOwn : Promise.resolve(ownDoc(3)),
    readShares: () => ++shareReads === 1 ? oldShares : Promise.resolve([]),
    now: () => nowMs,
  });
  const oldRead = state.refreshViewerAccountsIfStale({ maxAgeMs: 0 });
  nowMs = 1000;
  await state.reloadViewerAccounts(ownDoc(2));
  nowMs = 5000;
  resolveOwn(ownDoc(1));
  resolveShares([shared]);
  await oldRead;
  assert.equal(state.userDoc.version, 2);
  assert.deepEqual(state.accounts.map(account => account.accountName), ["Own"]);
  assert.equal(state.totalCharacters, 1);
  nowMs = 6000;
  assert.equal(await state.refreshViewerAccountsIfStale(), true, "discarded reads must not renew snapshot freshness");
  assert.equal(state.userDoc.version, 3);
});

test("a deleted own document clears its rosters while preserving currently authorized shares", async () => {
  for (const shares of [[], [shared]]) {
    const state = await createState({ readOwn: async () => null, readShares: async () => shares });
    await state.reloadViewerAccounts();
    assert.deepEqual(state.userDoc.accounts, []);
    assert.deepEqual(state.accounts, shares);
    assert.equal(state.totalCharacters, shares.length);
    assert.equal(state.visibleRosterCount, shares.length);
  }
});

test("a failed roster read preserves the last successfully loaded snapshot", async () => {
  const state = await createState({ readOwn: async () => { throw new Error("Mongo unavailable"); } });
  const accounts = state.accounts;
  const userDoc = state.userDoc;
  await assert.rejects(state.reloadViewerAccounts(), /Mongo unavailable/);
  assert.equal(state.accounts, accounts);
  assert.equal(state.userDoc, userDoc);
});

test("coalescing cannot retain a superseded read or clear a newer pending reload", async () => {
  let finishOld, finishNew, reads = 0, nowMs = 0;
  const oldOwn = new Promise(resolve => { finishOld = resolve; });
  const newOwn = new Promise(resolve => { finishNew = resolve; });
  const state = await createState({ readOwn: () => ++reads === 1 ? oldOwn : newOwn, now: () => nowMs });
  const oldRead = state.refreshViewerAccountsIfStale({ maxAgeMs: 0 });
  nowMs = 1000;
  await state.reloadViewerAccounts(ownDoc(2));
  nowMs = 6000;
  const freshRead = state.refreshViewerAccountsIfStale();
  try {
    assert.notEqual(freshRead, oldRead, "a stale read must not block refreshing the newer snapshot");
    finishOld(ownDoc(1));
    await oldRead;
    assert.equal(state.refreshViewerAccountsIfStale(), freshRead, "an old finalizer must not clear the newer in-flight read");
    assert.equal(reads, 2);
    finishNew(ownDoc(3));
    await freshRead;
    assert.equal(state.userDoc.version, 3);
  } finally {
    finishOld(ownDoc(1));
    finishNew(ownDoc(3));
    await Promise.allSettled([oldRead, freshRead]);
  }
});
