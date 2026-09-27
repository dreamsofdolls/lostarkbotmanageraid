"use strict";

function createImageCache({ maxBytes = 16 * 1024 * 1024, ttlMs = 5 * 60_000, now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) bytes -= entry.result.buffer.length;
    entries.delete(key);
  }
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return;
      if (now() >= entry.expires) return remove(key);
      entries.delete(key);
      entries.set(key, entry);
      return entry.result;
    },
    set(key, result) {
      remove(key);
      for (const [id, entry] of entries) if (now() >= entry.expires) remove(id);
      if (result.buffer.length > maxBytes) return;
      while (bytes + result.buffer.length > maxBytes) remove(entries.keys().next().value);
      entries.set(key, { result, expires: now() + ttlMs });
      bytes += result.buffer.length;
    },
  };
}

module.exports = { createImageCache };
