"use strict";

function createImageCache({ maxBytes = 16 * 1024 * 1024, ttlMs = 5 * 60_000, now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  const sizeOf = result => result.images
    ? result.images.reduce((sum, image) => sum + image.buffer.length, 0) : result.buffer.length;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) bytes -= sizeOf(entry.result);
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
      const size = sizeOf(result);
      if (size > maxBytes) return;
      while (bytes + size > maxBytes) remove(entries.keys().next().value);
      entries.set(key, { result, expires: now() + ttlMs });
      bytes += size;
    },
    invalidateLog(id) {
      for (const key of entries.keys()) if (key.startsWith(`${id}:`)) remove(key);
    },
  };
}

module.exports = { createImageCache };
