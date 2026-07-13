"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTO_MANAGE_STATUS_STALE_MS,
  isAutoManageAttemptStale,
} = require("../bot/services/auto-manage/runtime/support/freshness");

test("auto-manage freshness treats missing attempts as stale", () => {
  assert.equal(isAutoManageAttemptStale({}), true);
  assert.equal(isAutoManageAttemptStale({ lastAutoManageAttemptAt: null }), true);
});

test("auto-manage freshness gates recent attempts from view piggyback", () => {
  const nowMs = 1_000_000;
  assert.equal(
    isAutoManageAttemptStale(
      { lastAutoManageAttemptAt: nowMs - AUTO_MANAGE_STATUS_STALE_MS + 1 },
      { nowMs }
    ),
    false
  );
  assert.equal(
    isAutoManageAttemptStale(
      { lastAutoManageAttemptAt: nowMs - AUTO_MANAGE_STATUS_STALE_MS },
      { nowMs }
    ),
    true
  );
});
