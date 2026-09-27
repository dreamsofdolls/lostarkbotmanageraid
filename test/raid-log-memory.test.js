"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readCaptureMemory } = require("../bot/services/raid-log/memory");

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
