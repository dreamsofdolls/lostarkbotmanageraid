"use strict";

/**
 * Coalesce overlapping requests into the fewest possible async runs.
 * Requests made before a run starts share that run; requests made while it is
 * running share one follow-up run with the latest state.
 */
function createLatestOnlyQueue(run, { onError = null } = {}) {
  if (typeof run !== "function") {
    throw new TypeError("createLatestOnlyQueue requires a run function");
  }

  let requestedVersion = 0;
  let completedVersion = 0;
  let drainPromise = null;
  const pendingLabels = new Set();

  const drain = async () => {
    while (completedVersion < requestedVersion) {
      const targetVersion = requestedVersion;
      const labels = [...pendingLabels];
      pendingLabels.clear();
      try {
        await run(labels);
      } catch (err) {
        if (typeof onError === "function") {
          try {
            await onError(err, labels);
          } catch {
            // Error reporting must not wedge the queue.
          }
        }
      }
      completedVersion = targetVersion;
    }
  };

  const ensureDrain = () => {
    if (drainPromise) return drainPromise;
    drainPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        drainPromise = null;
        // A request can arrive after drain resolves but before this finalizer.
        // Schedule another pass so that edge never loses the newest state.
        if (completedVersion < requestedVersion) ensureDrain();
      });
    return drainPromise;
  };

  const request = (label = "update") => {
    requestedVersion += 1;
    if (label) pendingLabels.add(String(label));
    return ensureDrain();
  };

  const flush = async () => {
    while (drainPromise || completedVersion < requestedVersion) {
      await (drainPromise || ensureDrain());
    }
  };

  return { request, flush };
}

module.exports = { createLatestOnlyQueue };
