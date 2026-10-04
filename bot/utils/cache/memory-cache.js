"use strict";

/**
 * Byte-budgeted LRU cache with absolute per-entry expiry. Deliberately a
 * sibling of, not a merge with, createExpiringKeyMap: that one trades the
 * byte accounting and get-refresh for set-time sliding TTL and in-place
 * entry mutation. Pick by which eviction/expiry contract the caller needs.
 *
 * @param {{ maxBytes: number, maxEntries: number, ttlMs: number, sizeOf: Function, now?: Function }} options
 * @returns {{ get: Function, set: Function, delete: Function, invalidate: Function, clear: Function }} expiring LRU cache
 */
function createMemoryCache({ maxBytes, maxEntries, ttlMs, sizeOf, now = Date.now }) {
  const entries = new Map();
  let bytes = 0;
  let expiryTimer;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) bytes -= entry.size;
    entries.delete(key);
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (!entries.size) return;
    const expires = Math.min(...[...entries.values()].map(entry => entry.expires));
    expiryTimer = setTimeout(() => {
      const time = now();
      for (const [key, entry] of entries) if (time >= entry.expires) remove(key);
      scheduleExpiry();
    }, Math.max(1, expires - now()));
    expiryTimer.unref?.();
  }
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return;
      if (now() >= entry.expires) { remove(key); scheduleExpiry(); return; }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, lifetimeMs = ttlMs) {
      remove(key);
      const time = now();
      for (const [id, entry] of entries) if (time >= entry.expires) remove(id);
      const size = sizeOf(value);
      if (size <= maxBytes && maxEntries > 0 && lifetimeMs > 0) {
        while (bytes + size > maxBytes || entries.size >= maxEntries) remove(entries.keys().next().value);
        entries.set(key, { value, size, expires: time + Math.min(ttlMs, lifetimeMs) });
        bytes += size;
      }
      scheduleExpiry();
    },
    delete(key) {
      remove(key);
      scheduleExpiry();
    },
    invalidate(matches) {
      for (const key of entries.keys()) if (matches(key)) remove(key);
      scheduleExpiry();
    },
    clear() {
      clearTimeout(expiryTimer);
      entries.clear();
      bytes = 0;
    },
  };
}

module.exports = { createMemoryCache };
