"use strict";

/**
 * Keep short-lived keyed state under one expiry timer and a fixed entry cap.
 * Writes replace the key's expiry; mutating a returned value does not.
 * @param {object} options Expiry policy and injected clock/timers.
 * @param {number} options.ttlMs Time an entry remains readable after set().
 * @param {number} options.maxEntries Maximum retained keys.
 * @param {() => number} [options.now] Clock returning epoch milliseconds.
 * @param {Function} [options.setTimeoutFn] Timer scheduler.
 * @param {Function} [options.clearTimeoutFn] Timer cancellation function.
 * @returns {{get: Function, set: Function, clear: Function, size: Function}} bounded state map.
 */
function createExpiringKeyMap({
  ttlMs,
  maxEntries,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const entries = new Map();
  let sweepTimer = null;

  function scheduleSweep() {
    if (sweepTimer !== null || entries.size === 0) return;
    let earliestExpiry = Infinity;
    for (const entry of entries.values()) {
      earliestExpiry = Math.min(earliestExpiry, entry.touchedAt + ttlMs);
    }
    sweepTimer = setTimeoutFn(sweep, Math.max(1, earliestExpiry - now()));
    sweepTimer?.unref?.();
  }

  function stopSweepIfEmpty() {
    if (entries.size > 0 || sweepTimer === null) return;
    clearTimeoutFn(sweepTimer);
    sweepTimer = null;
  }

  function sweep() {
    sweepTimer = null;
    const currentTime = now();
    for (const [key, entry] of entries) {
      if (currentTime - entry.touchedAt >= ttlMs) entries.delete(key);
    }
    scheduleSweep();
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.touchedAt >= ttlMs) {
        entries.delete(key);
        stopSweepIfEmpty();
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, touchedAt: now() });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      scheduleSweep();
    },
    clear() {
      if (sweepTimer !== null) clearTimeoutFn(sweepTimer);
      sweepTimer = null;
      entries.clear();
    },
    size: () => entries.size,
  };
}

module.exports = {
  createExpiringKeyMap,
};
