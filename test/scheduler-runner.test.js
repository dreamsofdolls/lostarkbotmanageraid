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
