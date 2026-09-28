"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readCaptureMemory, canCollectSupportShares } = require("../bot/services/raid-log/memory");

test("capture diagnostics retain cgroup byte counts and OOM counters without guessing a cause", async () => {
  const values = { current: "123456\n", max: "max\n", peak: "999999\n", events: "low 0\nhigh 0\noom 2\noom_kill 1\n" };
  assert.deepEqual(await readCaptureMemory(async file => values[file.split(".").at(-1)]), {
    current: "123456", max: "max", peak: "999999", events: "low 0; high 0; oom 2; oom_kill 1",
  });
});

test("missing cgroup files remain unavailable, and a partial read preserves available evidence", async () => {
  const missing = async () => { throw new Error("ENOENT"); };
  assert.deepEqual(await readCaptureMemory(missing), {});
  assert.deepEqual(await readCaptureMemory(file => file.endsWith(".current") ? "123\n" : missing()), { current: "123" });
});

test("support detail policy distinguishes small limits, low headroom and unavailable readings", () => {
  for (const memory of [{ max: "512000000", current: "82161664" }, { max: "536870912" },
    { max: "1073741824", current: "805306369" }, { max: "1073741824", current: "1073741824" }]) {
    assert.equal(canCollectSupportShares(memory), false);
  }
  for (const memory of [{}, { max: "max", current: "943718400" }, { max: "bad" }, { max: "0" },
    { max: "1073741824" }, { max: "1073741824", current: "unknown" }, { max: "1073741824", current: "805306368" }]) {
    assert.equal(canCollectSupportShares(memory), true);
  }
});
