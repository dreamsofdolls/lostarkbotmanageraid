"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createExpiringKeyMap,
} = require("../bot/utils/cache/expiring-key-map");

function createHarness({ ttlMs, maxEntries }) {
  let currentTime = 0;
  let timer = null;
  let timerCalls = 0;
  const map = createExpiringKeyMap({
    ttlMs,
    maxEntries,
    now: () => currentTime,
    setTimeoutFn: (callback, delay) => {
      timerCalls += 1;
      timer = { callback, delay, unref() {} };
      return timer;
    },
    clearTimeoutFn: (handle) => {
      if (timer === handle) timer = null;
    },
  });

  return {
    map,
    timerCalls: () => timerCalls,
    advanceToNextSweep() {
      assert.ok(timer);
      currentTime += timer.delay;
      timer.callback();
    },
  };
}

test("expiring key map releases idle entries with one shared sweep", () => {
  const harness = createHarness({ ttlMs: 100, maxEntries: 10 });
  harness.map.set("user-a", { value: "a" });
  harness.map.set("user-b", { value: "b" });

  assert.equal(harness.timerCalls(), 1);
  assert.equal(harness.map.size(), 2);

  harness.advanceToNextSweep();

  assert.equal(harness.map.size(), 0);
});

test("expiring key map evicts the oldest key above its cap", () => {
  const harness = createHarness({ ttlMs: 60_000, maxEntries: 2 });
  harness.map.set("user-a", "a");
  harness.map.set("user-b", "b");
  harness.map.set("user-c", "c");

  assert.equal(harness.map.size(), 2);
  assert.equal(harness.map.get("user-a"), undefined);
  assert.equal(harness.map.get("user-b"), "b");
  assert.equal(harness.map.get("user-c"), "c");
  assert.equal(harness.timerCalls(), 1);
});
