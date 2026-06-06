"use strict";

function createNonOverlappingIntervalRunner({
  tickMs,
  runTick,
  overlapMessage,
  errorMessage,
  nowMs = () => Date.now(),
  setIntervalFn = (...args) => setInterval(...args),
}) {
  let startedAtMs = null;
  let tickInFlight = false;

  function start(...runArgs) {
    startedAtMs = nowMs();
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
    return setIntervalFn(run, tickMs);
  }

  return {
    start,
    getStartedAtMs: () => startedAtMs,
  };
}

module.exports = {
  createNonOverlappingIntervalRunner,
};
