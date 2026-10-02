"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidStatusLiveApplyRefresh,
} = require("../bot/handlers/raid-status/sync/live-apply-refresh");

function createHarness({ currentView = "sync" } = {}) {
  let eventListener = null;
  let cleanupCalls = 0;
  let reloadCalls = 0;
  let metaCalls = 0;
  let redrawCalls = 0;
  let liveUserDoc = {
    discordId: "viewer",
    localSyncEnabled: false,
    lastLocalSyncAt: 0,
    accounts: [],
  };
  let rebuiltMeta = null;
  const snapshotJobs = [];
  const snapshots = [];
  const subscriptions = [];
  const accounts = [
    { accountName: "Own" },
    { accountName: "Shared", _sharedFrom: { ownerDiscordId: "shared-owner" } },
  ];
  const refresh = createRaidStatusLiveApplyRefresh({
    viewerDiscordId: "viewer",
    getAccounts: () => accounts,
    getCurrentView: () => currentView,
    isSessionEnded: () => false,
    reloadViewerAccounts: async () => {
      reloadCalls += 1;
      liveUserDoc = {
        discordId: "viewer",
        localSyncEnabled: true,
        lastLocalSyncAt: 456,
        accounts,
      };
      // The command wrapper historically returned undefined. Metadata must be
      // rebuilt from current session state rather than trusting this return.
    },
    rebuildStatusUserMeta: () => {
      metaCalls += 1;
      rebuiltMeta = {
        localSyncEnabled: liveUserDoc.localSyncEnabled,
        lastLocalSyncAt: liveUserDoc.lastLocalSyncAt,
      };
    },
    refreshLocalSyncSnapshot: async ({ jobId }) => {
      snapshotJobs.push(jobId);
      return { jobId };
    },
    setLocalSyncSnapshot: (snapshot) => {
      snapshots.push(snapshot);
    },
    redrawMessage: async () => {
      redrawCalls += 1;
    },
    subscribe: (ownerIds, listener) => {
      subscriptions.push(ownerIds);
      eventListener = listener;
      return () => {
        cleanupCalls += 1;
      };
    },
    log: { warn() {} },
  });
  return {
    refresh,
    emit(event) {
      eventListener(event);
    },
    stats() {
      return {
        cleanupCalls,
        metaCalls,
        rebuiltMeta,
        redrawCalls,
        reloadCalls,
        snapshotJobs,
        snapshots,
        subscriptions,
      };
    },
  };
}

test("active raid-status coalesces Reader bursts and renders the latest own preview", async () => {
  const harness = createHarness();
  harness.refresh.start();

  harness.emit({ discordId: "viewer", jobId: "job-1" });
  harness.emit({ discordId: "viewer", jobId: "job-2" });
  await harness.refresh.flush();

  assert.deepEqual(harness.stats(), {
    cleanupCalls: 0,
    metaCalls: 1,
    rebuiltMeta: { localSyncEnabled: true, lastLocalSyncAt: 456 },
    redrawCalls: 1,
    reloadCalls: 1,
    snapshotJobs: ["job-2"],
    snapshots: [{ jobId: "job-2" }],
    subscriptions: [["viewer", "shared-owner"]],
  });
});

test("a shared roster owner's Reader apply reloads the card without replacing viewer sync preview", async () => {
  const harness = createHarness();
  harness.refresh.start();

  harness.emit({ discordId: "shared-owner", jobId: "shared-job" });
  await harness.refresh.flush();

  assert.equal(harness.stats().reloadCalls, 1);
  assert.equal(harness.stats().metaCalls, 1);
  assert.deepEqual(
    harness.stats().rebuiltMeta,
    { localSyncEnabled: true, lastLocalSyncAt: 456 }
  );
  assert.equal(harness.stats().redrawCalls, 1);
  assert.deepEqual(harness.stats().snapshotJobs, []);
});

test("stopping raid-status removes the apply subscription and ignores late events", async () => {
  const harness = createHarness();
  harness.refresh.start();
  harness.refresh.stop();

  harness.emit({ discordId: "viewer", jobId: "late-job" });
  await harness.refresh.flush();

  assert.equal(harness.stats().cleanupCalls, 1);
  assert.equal(harness.stats().reloadCalls, 0);
  assert.equal(harness.stats().redrawCalls, 0);
});

test("ending raid-status during its Mongo reload skips metadata, preview, and redraw work", async () => {
  let eventListener = null;
  let resolveReload;
  let metaCalls = 0;
  let snapshotCalls = 0;
  let redrawCalls = 0;
  const reloadPending = new Promise((resolve) => {
    resolveReload = resolve;
  });
  const refresh = createRaidStatusLiveApplyRefresh({
    viewerDiscordId: "viewer-ending",
    getAccounts: () => [{ accountName: "Own" }],
    getCurrentView: () => "sync",
    isSessionEnded: () => false,
    reloadViewerAccounts: () => reloadPending,
    rebuildStatusUserMeta: () => {
      metaCalls += 1;
    },
    refreshLocalSyncSnapshot: async () => {
      snapshotCalls += 1;
      return {};
    },
    setLocalSyncSnapshot: () => {},
    redrawMessage: async () => {
      redrawCalls += 1;
    },
    subscribe: (_ids, listener) => {
      eventListener = listener;
      return () => {};
    },
    log: { warn() {} },
  });
  refresh.start();
  eventListener({ discordId: "viewer-ending", jobId: "job-ending" });
  await Promise.resolve();

  refresh.stop();
  resolveReload();
  await refresh.flush();

  assert.equal(metaCalls, 0);
  assert.equal(snapshotCalls, 0);
  assert.equal(redrawCalls, 0);
});
