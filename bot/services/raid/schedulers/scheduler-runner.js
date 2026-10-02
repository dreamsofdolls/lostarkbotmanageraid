"use strict";

/**
 * Create an immediate, non-overlapping scheduler with optional wall-clock ticks.
 * @param {object} options - Tick callback, clock and injectable timer functions.
 * @returns {{start: Function, getStartedAtMs: Function}} scheduler lifecycle.
 */
function createNonOverlappingIntervalRunner({
  tickMs,
  runTick,
  overlapMessage,
  errorMessage,
  alignToClock = false,
  nowMs = () => Date.now(),
  setIntervalFn = (...args) => setInterval(...args),
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = (handle) => clearTimeout(handle),
}) {
  let startedAtMs = null;
  let tickInFlight = false;
  const clockRemainderMs = (currentMs) => ((currentMs % tickMs) + tickMs) % tickMs;

  function start(...runArgs) {
    const startMs = nowMs();
    startedAtMs = alignToClock ? startMs - clockRemainderMs(startMs) : startMs;
    const run = async () => {
      if (tickInFlight) {
        if (overlapMessage) console.warn(overlapMessage);
        return;
      }
      tickInFlight = true;
      try {
        await runTick(...runArgs);
      } catch (err) {
        if (errorMessage) console.error(errorMessage, err?.message || err);
      } finally {
        tickInFlight = false;
      }
    };
    run();
    if (!alignToClock) return setIntervalFn(run, tickMs);

    let stopped = false;
    let unrefTimers = false;
    let timeoutHandle = null;
    const scheduleNext = () => {
      if (stopped) return;
      const remainder = clockRemainderMs(nowMs());
      const delayMs = remainder === 0 ? tickMs : tickMs - remainder;
      timeoutHandle = setTimeoutFn(async () => {
        if (stopped) return;
        await run();
        scheduleNext();
      }, delayMs);
      if (unrefTimers) timeoutHandle?.unref?.();
    };
    const handle = {
      close() {
        if (stopped) return;
        stopped = true;
        if (timeoutHandle !== null) clearTimeoutFn(timeoutHandle);
      },
      unref() {
        unrefTimers = true;
        timeoutHandle?.unref?.();
        return handle;
      },
    };
    scheduleNext();
    return handle;
  }

  return {
    start,
    getStartedAtMs: () => startedAtMs,
  };
}

module.exports = {
  createNonOverlappingIntervalRunner,
};
