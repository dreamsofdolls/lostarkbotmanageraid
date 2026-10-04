"use strict";

const { createMemoryCache } = require("../../utils/cache/memory-cache");

/**
 * @param {{ maxBytes?: number, maxEntries?: number, ttlMs?: number, now?: Function }} [options]
 * @returns {{ get: Function, set: Function, invalidateLog: Function, clear: Function }} bounded PNG cache
 */
function createImageCache({ maxBytes = 16 * 1024 * 1024, maxEntries = 64, ttlMs = 5 * 60_000, now = Date.now } = {}) {
  const cache = createMemoryCache({ maxBytes, maxEntries, ttlMs, now,
    sizeOf: result => result.images.reduce((sum, image) => sum + image.buffer.length, 0) });
  return {
    get: cache.get, set: cache.set, clear: cache.clear,
    invalidateLog(id) {
      cache.invalidate(key => key.startsWith(`${id}:`));
    },
  };
}

module.exports = { createImageCache };
