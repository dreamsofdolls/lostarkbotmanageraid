"use strict";

function createInFlightLoader(
  loadFn,
  { ttlMs = 0, maxEntries = Number.POSITIVE_INFINITY, now = Date.now } = {}
) {
  if (typeof loadFn !== "function") {
    throw new Error("[in-flight-loader] loadFn must be a function");
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error("[in-flight-loader] ttlMs must be a non-negative finite number");
  }
  if (typeof now !== "function") {
    throw new Error("[in-flight-loader] now must be a function");
  }

  const entryLimit = Number.isFinite(maxEntries)
    ? Math.max(1, Math.floor(maxEntries))
    : Number.POSITIVE_INFINITY;
  const entries = new Map();

  function evictOldestSettledEntry() {
    for (const [key, entry] of entries) {
      if (entry.settledAt === null) continue;
      entries.delete(key);
      return true;
    }
    return false;
  }

  function loadOnce(key) {
    const cached = entries.get(key);
    if (cached) {
      const isInFlight = cached.settledAt === null;
      const isFresh = ttlMs > 0 && now() - cached.settledAt < ttlMs;
      if (isInFlight || isFresh) {
        if (!isInFlight) {
          // Touch resolved entries so bounded eviction behaves like LRU.
          entries.delete(key);
          entries.set(key, cached);
        }
        return cached.promise;
      }
      entries.delete(key);
    }

    while (entries.size >= entryLimit && evictOldestSettledEntry()) {
      // Keep in-flight work coalesced even if a temporary burst exceeds
      // the settled-entry limit.
    }

    const entry = { promise: null, settledAt: null };
    entry.promise = Promise.resolve()
      .then(() => loadFn(key))
      .then(
        (value) => {
          entry.settledAt = now();
          if (ttlMs === 0 && entries.get(key) === entry) entries.delete(key);
          return value;
        },
        (error) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        }
      );
    entries.set(key, entry);
    return entry.promise;
  }

  loadOnce.invalidate = (key) => entries.delete(key);
  loadOnce.clear = () => entries.clear();
  loadOnce.cachedKeyCount = () => entries.size;

  return loadOnce;
}

module.exports = {
  createInFlightLoader,
};
