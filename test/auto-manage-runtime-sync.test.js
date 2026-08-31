"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAutoManageSyncService,
} = require("../bot/services/auto-manage/runtime/sync");

function createService({ doc, applyAutoManageCollected, ensureFreshWeek = () => false }) {
  return createAutoManageSyncService({
    User: {
      findOne: async () => doc,
    },
    saveWithRetry: async (operation) => operation(),
    ensureFreshWeek,
    applyAutoManageCollected,
  });
}

test("commitAutoManageCollected applies, stamps, saves, and returns one reusable snapshot", async () => {
  let saves = 0;
  const snapshot = {};
  const doc = {
    autoManageEnabled: true,
    accounts: [{ accountName: "Roster" }],
    async save() {
      saves += 1;
    },
    toObject() {
      snapshot.lastAutoManageAttemptAt = this.lastAutoManageAttemptAt;
      snapshot.lastAutoManageSyncAt = this.lastAutoManageSyncAt;
      snapshot.weekFresh = this.weekFresh;
      return snapshot;
    },
  };
  const report = {
    perChar: [{ error: null, applied: [{ raidKey: "kazeros", gate: "G1" }] }],
  };
  const service = createService({
    doc,
    ensureFreshWeek(target) {
      target.weekFresh = true;
      return true;
    },
    applyAutoManageCollected(target, weekResetStart, collected) {
      assert.equal(target, doc);
      assert.equal(weekResetStart, 1234);
      assert.deepEqual(collected, { logs: true });
      return report;
    },
  });

  const result = await service.commitAutoManageCollected(
    "user-1",
    1234,
    { logs: true }
  );

  assert.equal(result.status, "synced-with-delta");
  assert.equal(result.report, report);
  assert.equal(result.snapshot, snapshot);
  assert.equal(saves, 1);
  assert.equal(doc.lastAutoManageAttemptAt, doc.lastAutoManageSyncAt);
  assert.ok(Number.isFinite(doc.lastAutoManageAttemptAt));
  assert.equal(snapshot.weekFresh, true);
});

test("commitAutoManageCollected stamps an attempt without applying after opt-out", async () => {
  let saves = 0;
  let applyCalls = 0;
  const doc = {
    autoManageEnabled: false,
    accounts: [{ accountName: "Roster" }],
    async save() {
      saves += 1;
    },
  };
  const service = createService({
    doc,
    applyAutoManageCollected() {
      applyCalls += 1;
      return { perChar: [] };
    },
  });

  const result = await service.commitAutoManageCollected(
    "user-1",
    1234,
    { logs: true }
  );

  assert.equal(result.status, "attempt-stamped");
  assert.equal(result.report, null);
  assert.equal(applyCalls, 0);
  assert.equal(saves, 1);
  assert.ok(Number.isFinite(doc.lastAutoManageAttemptAt));
});

test("commitAutoManageCollected can reject a roster removed during gather", async () => {
  let saves = 0;
  let freshens = 0;
  const doc = {
    autoManageEnabled: true,
    accounts: [],
    async save() {
      saves += 1;
    },
  };
  const service = createService({
    doc,
    ensureFreshWeek() {
      freshens += 1;
      return true;
    },
    applyAutoManageCollected() {
      throw new Error("must not apply without a roster");
    },
  });

  const result = await service.commitAutoManageCollected(
    "user-1",
    1234,
    { logs: true },
    { requireRoster: true }
  );

  assert.equal(result.status, "missing-roster");
  assert.equal(result.snapshot, null);
  assert.equal(freshens, 0);
  assert.equal(saves, 0);
});
