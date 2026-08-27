"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  commitCollectedRaidViewRefresh,
} = require("../bot/services/raid/view-refresh-commit");

function createCommit(overrides = {}) {
  let saves = 0;
  const doc = {
    discordId: "user-1",
    autoManageEnabled: true,
    save: async () => {
      saves += 1;
    },
    toObject() {
      return {
        discordId: this.discordId,
        autoManageEnabled: this.autoManageEnabled,
        lastAutoManageAttemptAt: this.lastAutoManageAttemptAt,
      };
    },
  };
  const options = {
    User: { findOne: async () => doc },
    saveWithRetry: async (operation) => operation(),
    discordId: "user-1",
    ensureFreshWeek: () => false,
    applyStaleAccountRefreshes: () => false,
    refreshCollected: [],
    applyAutoManageCollected: () => ({ perChar: [] }),
    autoManageCollected: null,
    autoManageWeekResetStart: 123,
    autoManageBibleHit: false,
    ...overrides,
  };
  return { doc, options, saves: () => saves };
}

test("raid view refresh commit skips save when no collected mutation applies", async () => {
  const context = createCommit();
  const snapshot = await commitCollectedRaidViewRefresh(context.options);

  assert.equal(context.saves(), 0);
  assert.equal(snapshot.discordId, "user-1");
});

test("raid view refresh commit applies auto-manage and exposes the report hook", async () => {
  const reports = [];
  const report = { perChar: [{ applied: 2 }] };
  const context = createCommit({
    autoManageCollected: [{ characterName: "Charone" }],
    applyAutoManageCollected: (doc, resetStart, collected) => {
      assert.equal(doc.discordId, "user-1");
      assert.equal(resetStart, 123);
      assert.equal(collected.length, 1);
      return report;
    },
    onAutoManageReport: (value) => reports.push(value),
  });

  const snapshot = await commitCollectedRaidViewRefresh(context.options);

  assert.equal(context.saves(), 1);
  assert.deepEqual(reports, [report]);
  assert.ok(Number(snapshot.lastAutoManageAttemptAt) > 0);
});

test("raid view refresh commit stamps a completed Bible attempt even without collected data", async () => {
  const context = createCommit({ autoManageBibleHit: true });
  const snapshot = await commitCollectedRaidViewRefresh(context.options);

  assert.equal(context.saves(), 1);
  assert.ok(Number(snapshot.lastAutoManageAttemptAt) > 0);
});
