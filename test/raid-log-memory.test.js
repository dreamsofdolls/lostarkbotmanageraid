"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readCaptureMemory, shouldReleaseBrowser } = require("../bot/services/raid-log/memory");

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

test("release policy accounts for finite headroom and both framing surfaces", () => {
  const limit = 512 * 1024 * 1024;
  const memory = free => ({ max: String(limit), current: String(limit - free) });
  assert.equal(shouldReleaseBrowser(memory(128 * 1024 * 1024)), false);
  assert.equal(shouldReleaseBrowser(memory(128 * 1024 * 1024 - 1)), true);
  assert.equal(shouldReleaseBrowser(memory(140 * 1024 * 1024), [{ width: 1280, height: 1214 }]), true);
  assert.equal(shouldReleaseBrowser(memory(160 * 1024 * 1024), [{ width: 1280, height: 1214 }]), false);
  assert.equal(shouldReleaseBrowser(memory(130 * 1024 * 1024), [{ width: 1600, height: 900 }]), false);
  assert.equal(shouldReleaseBrowser({ max: "512000000", current: "512000001" }), true);
  // Sequential framing reserves only the largest pair, not every image at once.
  assert.equal(shouldReleaseBrowser(memory(150 * 1024 * 1024), [
    { width: 1280, height: 1214 }, { width: 1280, height: 1214 },
  ]), false);
});

test("unlimited, missing or invalid readings do not invent memory pressure", () => {
  for (const memory of [{}, { max: "max", current: "943718400" }, { max: "bad" }, { max: "0" },
    { max: "1073741824" }, { max: "1073741824", current: "unknown" }, { max: "512000000", current: -1 },
    { max: "512000000", current: null }, { max: "512000000", current: "" }]) {
    assert.equal(shouldReleaseBrowser(memory), false);
  }
});
