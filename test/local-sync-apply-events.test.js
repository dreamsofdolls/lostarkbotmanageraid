"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_LOCAL_SYNC_APPLY_SUBSCRIBERS_PER_USER,
  publishLocalSyncApplied,
  subscribeLocalSyncApplied,
} = require("../bot/services/local-sync/core/apply-events");

test("Local Reader apply events notify only subscribed roster owners and cleanup fully", () => {
  const seen = [];
  const unsubscribe = subscribeLocalSyncApplied(["owner-a", "shared-owner"], (event) => {
    seen.push(event);
  });

  assert.equal(publishLocalSyncApplied({ discordId: "other", jobId: "ignored" }), 0);
  assert.equal(publishLocalSyncApplied({ discordId: "owner-a", jobId: "job-1" }), 1);
  assert.deepEqual(seen, [{ discordId: "owner-a", jobId: "job-1" }]);

  unsubscribe();
  unsubscribe();
  assert.equal(publishLocalSyncApplied({ discordId: "shared-owner", jobId: "job-2" }), 0);
  assert.equal(seen.length, 1);
});

test("Local Reader apply subscriptions stay bounded per roster owner", () => {
  const owner = "bounded-owner";
  const calls = Array.from(
    { length: MAX_LOCAL_SYNC_APPLY_SUBSCRIBERS_PER_USER + 2 },
    () => 0
  );
  const cleanups = calls.map((_value, index) => subscribeLocalSyncApplied(owner, () => {
    calls[index] += 1;
  }));

  assert.equal(
    publishLocalSyncApplied({ discordId: owner, jobId: "job" }),
    MAX_LOCAL_SYNC_APPLY_SUBSCRIBERS_PER_USER
  );
  assert.deepEqual(calls.slice(0, 2), [0, 0]);
  assert.ok(calls.slice(2).every((count) => count === 1));

  for (const cleanup of cleanups) cleanup();
  assert.equal(publishLocalSyncApplied({ discordId: owner, jobId: "after-cleanup" }), 0);
});
