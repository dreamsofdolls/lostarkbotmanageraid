"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAutoManageSyncHandler } = require("../bot/handlers/raid/auto-manage/core/sync");
const { createAutoManageEnableHandler } = require("../bot/handlers/raid/auto-manage/core/enable");
const { createAutoManageSyncSlotManager } = require("../bot/services/auto-manage/runtime/support/slot");
const { createAutoManageCoreService } = require("../bot/services/auto-manage/runtime/core");

for (const [action, createHandler] of [["sync", createAutoManageSyncHandler], ["on", createAutoManageEnableHandler]]) {
  test(`${action} releases its slot when Discord acknowledgement fails`, async () => {
    const slots = createAutoManageSyncSlotManager({
      User: { findOne: () => ({ lean: async () => ({}) }) },
      getAutoManageCooldownMs: () => 0, defaultCooldownMs: 0,
    });
    await assert.rejects(createHandler(slots)({
      interaction: { deferReply: async () => { throw new Error("Unknown interaction"); } },
      discordId: "ack-user", lang: "en",
    }), /Unknown interaction/);
    assert.deepEqual(await slots.acquireAutoManageSyncSlot("ack-user"), { acquired: true });
    slots.releaseAutoManageSyncSlot("ack-user");
  });
}

test("manual Bible sync stops if Local Sync is enabled during gather", async () => {
  const doc = { autoManageEnabled: false, localSyncEnabled: false, accounts: [{ accountName: "Roster" }] };
  let released = false;
  let notice;
  doc.save = () => assert.fail("Local mode must not receive a Bible write");
  const handler = createAutoManageSyncHandler({
    User: { findOne: async () => doc }, saveWithRetry: fn => fn(), ensureFreshWeek: () => {},
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => { released = true; }, weekResetStartMs: () => 1234,
    gatherAutoManageLogsForUserDoc: async () => { doc.localSyncEnabled = true; return []; },
    applyAutoManageCollected: () => assert.fail("Must check mode before reconciliation"),
    buildAutoManageSyncReportEmbed: () => assert.fail("Must not show a sync success report"),
  });
  await handler({
    interaction: { deferReply: async () => {} }, discordId: "mode-user", lang: "en",
    editAutoNotice: async payload => { notice = payload; },
  });
  assert.equal(released, true);
  assert.match(notice.title, /local.sync/i);
});

function makeCore(doc, saveWithRetry = fn => fn()) {
  return createAutoManageCoreService({
    User: { findOne: async () => doc }, saveWithRetry, ensureFreshWeek: () => {},
    normalizeName: value => String(value || "").toLowerCase(), UI: {},
    bibleLimiter: { run: () => assert.fail("No network calls in a commit test") },
  });
}

test("action:on commit rejects Local Sync without enabling Bible or saving", async () => {
  const doc = {
    autoManageEnabled: false, localSyncEnabled: true,
    accounts: [{ accountName: "Roster", characters: [] }],
    save: () => assert.fail("A blocked commit must not save"),
  };
  await assert.rejects(makeCore(doc).commitAutoManageOn("enable-user", 1234, []), { code: "LOCAL_SYNC_ACTIVE" });
  assert.equal(doc.autoManageEnabled, false);
});

test("action:on rechecks Local Sync after an optimistic save retry", async () => {
  let attempts = 0;
  const doc = {
    autoManageEnabled: false, localSyncEnabled: false, accounts: [],
    save: async () => { const error = new Error("Mode changed"); error.name = "VersionError"; throw error; },
  };
  const core = makeCore(doc, async operation => {
    attempts += 1;
    try { await operation(); } catch (error) {
      assert.equal(error.name, "VersionError");
      doc.autoManageEnabled = false;
      doc.localSyncEnabled = true;
      attempts += 1;
      return operation();
    }
  });
  await assert.rejects(core.commitAutoManageOn("enable-user", 1234, []), { code: "LOCAL_SYNC_ACTIVE" });
  assert.equal(attempts, 2);
  assert.equal(doc.autoManageEnabled, false);
});
