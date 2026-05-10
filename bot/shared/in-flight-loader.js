"use strict";

function createInFlightLoader(loadFn) {
  if (typeof loadFn !== "function") {
    throw new Error("[in-flight-loader] loadFn must be a function");
  }

  const inFlight = new Map();
  return function loadOnce(key) {
    if (!inFlight.has(key)) {
      const promise = Promise.resolve()
        .then(() => loadFn(key))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
    }
    return inFlight.get(key);
  };
}

module.exports = {
  createInFlightLoader,
};
