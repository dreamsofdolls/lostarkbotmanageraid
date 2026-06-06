"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ALL_MODE_AUTO_SYNC_ACTION,
  resolveAllModeAutoSyncAction,
  resolveAllModeViewToggleTarget,
} = require("../bot/handlers/raid-check/all-mode/all-mode-actions");

function resolveFor({
  actionUserId = "user-a",
  autoManageEnabled,
  localSyncEnabled = false,
}) {
  return resolveAllModeAutoSyncAction({
    actionUserId,
    autoManageStateByDiscordId: new Map([["user-a", autoManageEnabled]]),
    localSyncStateByDiscordId: new Map([["user-a", localSyncEnabled]]),
  });
}

test("raid-check all-mode auto action hides buttons without a target user", () => {
  assert.equal(resolveFor({ actionUserId: "", autoManageEnabled: false }), null);
});

test("raid-check all-mode auto action hides manager toggles for local-sync users", () => {
  assert.equal(
    resolveFor({ autoManageEnabled: false, localSyncEnabled: true }),
    null
  );
  assert.equal(
    resolveFor({ autoManageEnabled: true, localSyncEnabled: true }),
    null
  );
});

test("raid-check all-mode auto action chooses enable or disable from current state", () => {
  assert.equal(
    resolveFor({ autoManageEnabled: false }),
    ALL_MODE_AUTO_SYNC_ACTION.enable
  );
  assert.equal(
    resolveFor({ autoManageEnabled: true }),
    ALL_MODE_AUTO_SYNC_ACTION.disable
  );
});

test("raid-check all-mode auto action hides buttons for unknown auto state", () => {
  assert.equal(resolveFor({ autoManageEnabled: undefined }), null);
});

test("raid-check all-mode view toggle target flips raid and task views", () => {
  assert.equal(resolveAllModeViewToggleTarget("raid"), "task");
  assert.equal(resolveAllModeViewToggleTarget("task"), "raid");
  assert.equal(resolveAllModeViewToggleTarget("other"), "raid");
});
