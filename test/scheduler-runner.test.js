const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createNonOverlappingIntervalRunner,
} = require("../bot/services/raid/schedulers/scheduler-runner");

test("non-overlapping scheduler runner starts immediately and skips overlapping ticks", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    let intervalFn = null;
    let releaseFirstTick = null;
    const calls = [];
    const runner = createNonOverlappingIntervalRunner({
      tickMs: 1234,
      nowMs: () => 42,
      setIntervalFn: (fn, ms) => {
        intervalFn = fn;
        return { ms };
      },
      overlapMessage: "overlap skipped",
      errorMessage: "tick failed:",
      runTick: async (label) => {
        calls.push(label);
        if (calls.length === 1) {
          await new Promise((resolve) => {
            releaseFirstTick = resolve;
          });
        }
      },
    });

    const handle = runner.start("tick-arg");
    assert.deepEqual(handle, { ms: 1234 });
    assert.equal(runner.getStartedAtMs(), 42);
    assert.equal(calls.length, 1);
    assert.equal(typeof intervalFn, "function");

    intervalFn();
    await Promise.resolve();
    assert.deepEqual(calls, ["tick-arg"]);
    assert.deepEqual(warnings, ["overlap skipped"]);

    releaseFirstTick();
    await Promise.resolve();
    await Promise.resolve();

    await intervalFn();
    assert.deepEqual(calls, ["tick-arg", "tick-arg"]);
  } finally {
    console.warn = originalWarn;
  }
});

test("non-overlapping scheduler runner logs tick errors and releases the guard", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    let intervalFn = null;
    let calls = 0;
    const runner = createNonOverlappingIntervalRunner({
      tickMs: 10,
      setIntervalFn: (fn) => {
        intervalFn = fn;
        return {};
      },
      overlapMessage: "overlap skipped",
      errorMessage: "tick failed:",
      runTick: async () => {
        calls += 1;
        throw new Error(`boom-${calls}`);
      },
    });

    runner.start();
    await Promise.resolve();
    await Promise.resolve();

    await intervalFn();
    assert.equal(calls, 2);
    assert.deepEqual(errors, [
      ["tick failed:", "boom-1"],
      ["tick failed:", "boom-2"],
    ]);
  } finally {
    console.error = originalError;
  }
});

test("aligned runner catches up immediately then follows wall-clock boundaries until closed", async () => {
  const startMs = Date.parse("2026-07-13T16:57:30.000Z");
  let now = startMs;
  const calls = [];
  const timers = [];
  const cleared = [];
  const runner = createNonOverlappingIntervalRunner({
    tickMs: 5 * 60_000,
    alignToClock: true,
    nowMs: () => now,
    setTimeoutFn: (fn, ms) => {
      const handle = { ms, unrefCount: 0, unref() { this.unrefCount += 1; } };
      timers.push({ fn, handle });
      return handle;
    },
    clearTimeoutFn: (handle) => cleared.push(handle),
    runTick: async (label) => calls.push({ label, now }),
  });

  const handle = runner.start("daily");
  assert.deepEqual(calls, [{ label: "daily", now: startMs }], "startup run provides catch-up");
  assert.equal(runner.getStartedAtMs(), Date.parse("2026-07-13T16:55:00.000Z"));
  assert.equal(timers[0].handle.ms, 2.5 * 60_000, "first timer lands on 00:00 VN");

  handle.unref();
  assert.equal(timers[0].handle.unrefCount, 1);
  await Promise.resolve();
  now = Date.parse("2026-07-13T17:00:00.000Z");
  await timers[0].fn();
  assert.equal(calls.length, 2);
  assert.equal(timers[1].handle.ms, 5 * 60_000);
  assert.equal(timers[1].handle.unrefCount, 1, "future timers inherit unref");

  handle.close();
  assert.deepEqual(cleared, [timers[1].handle]);
  now += 5 * 60_000;
  await timers[1].fn();
  assert.equal(calls.length, 2, "a stale timeout cannot run after close");
});
