"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRaidViewSnapshotService } = require("../bot/services/raid/view-snapshot");

// A service whose writes do nothing; `calls.acquire` counts piggyback slot requests.
function makeService(overrides = {}) {
  const calls = { acquire: 0 };
  const service = createRaidViewSnapshotService({
    User: { findOne: () => ({ lean: async () => null }) },
    saveWithRetry: async (op) => op(),
    ensureFreshWeek: () => false,
    getTargetResetKey: () => "week-1",
    collectStaleAccountRefreshes: async () => [],
    hasStaleAccountRefreshes: () => false,
    applyStaleAccountRefreshes: () => {},
    acquireAutoManageSyncSlot: async () => {
      calls.acquire += 1;
      return { acquired: false, release: () => {} };
    },
    gatherAutoManageLogsForUserDoc: async () => null,
    applyAutoManageCollected: () => {},
    stampAutoManageAttempt: async () => {},
    weekResetStartMs: () => 0,
    log: { error() {}, warn() {} },
    ...overrides,
  });
  return { service, calls };
}

// A current-week roster owner; Auto Sync is off unless a case turns it on.
const userDoc = (fields = {}) => ({
  discordId: "user-1",
  weeklyResetKey: "week-1",
  accounts: [{ accountName: "Main" }],
  autoManageEnabled: false,
  ...fields,
});
const STALE_SYNC = { autoManageEnabled: true, lastAutoManageAttemptAt: 0 };

test("raid-view-snapshot refuses to build without a dependency, naming the first one missing", () => {
  const cases = [
    [{ User: undefined }, "[raid-view-snapshot] User model required"],
    [{ saveWithRetry: null }, "[raid-view-snapshot] saveWithRetry required"],
    [{ ensureFreshWeek: "not a function" }, "[raid-view-snapshot] ensureFreshWeek required"],
    [{ getTargetResetKey: {} }, "[raid-view-snapshot] getTargetResetKey required"],
    [{ User: null, saveWithRetry: null }, "[raid-view-snapshot] User model required"],
    [{ ensureFreshWeek: null, getTargetResetKey: null }, "[raid-view-snapshot] ensureFreshWeek required"],
  ];
  for (const [missing, message] of cases) {
    assert.throws(() => makeService(missing), { message }, JSON.stringify(Object.keys(missing)));
  }
});

test("raid-view-snapshot asks for a fresh load in this order: no id, new week, no roster, stale refresh, Auto Sync", () => {
  const cases = [
    ["no document", null, {}, {}, false],
    ["no discord id", userDoc({ discordId: "" }), {}, {}, false],
    ["a new week, even with no roster", userDoc({ weeklyResetKey: "week-0", accounts: [] }), {}, {}, true],
    ["no roster, so no refresh and no Auto Sync", userDoc({ accounts: [], ...STALE_SYNC }), { hasStaleAccountRefreshes: () => true }, {}, false],
    ["a stale roster refresh", userDoc(), { hasStaleAccountRefreshes: () => true }, {}, true],
    ["a stale Auto Sync attempt", userDoc(STALE_SYNC), {}, {}, true],
    ["Auto Sync not allowed by the caller", userDoc(STALE_SYNC), {}, { allowAutoManage: false }, false],
    ["a recent Auto Sync attempt", userDoc({ ...STALE_SYNC, lastAutoManageAttemptAt: Date.now() }), {}, {}, false],
    ["Auto Sync off", userDoc({ lastAutoManageAttemptAt: 0 }), {}, {}, false],
  ];
  for (const [name, doc, deps, options, expected] of cases) {
    const { service } = makeService(deps);
    assert.strictEqual(service.shouldLoadFreshUserSnapshotForRaidViews(doc, options), expected, name);
  }
});

test("raid-view-snapshot piggybacks Auto Sync only for an allowed, enabled and stale attempt", async () => {
  const cases = [
    ["stale and allowed", userDoc(STALE_SYNC), {}, 1],
    ["not allowed", userDoc(STALE_SYNC), { allowAutoManage: false }, 0],
    ["Auto Sync off", userDoc({ lastAutoManageAttemptAt: 0 }), {}, 0],
    ["a recent attempt", userDoc({ ...STALE_SYNC, lastAutoManageAttemptAt: Date.now() }), {}, 0],
  ];
  for (const [name, doc, options, acquires] of cases) {
    const { service, calls } = makeService();
    const snapshot = await service.loadFreshUserSnapshotForRaidViews(doc, options);
    assert.strictEqual(calls.acquire, acquires, name);
    assert.strictEqual(snapshot, doc, `${name}: nothing to write returns the seed`);
  }
});

test("raid-view-snapshot releases a held piggyback slot through its handle, also when the load fails", async () => {
  let releases = 0;
  let stamps = 0;
  const { service } = makeService({
    acquireAutoManageSyncSlot: async () => ({ acquired: true, release: () => { releases += 1; } }),
    collectStaleAccountRefreshes: async () => { throw new Error("bible down"); },
    stampAutoManageAttempt: async () => { stamps += 1; },
  });
  await service.loadFreshUserSnapshotForRaidViews(userDoc(STALE_SYNC));
  assert.deepEqual({ releases, stamps }, { releases: 1, stamps: 1 });
});
