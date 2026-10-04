/**
 * services/raid-card/bg-loader.js
 *
 * Byte-bounded, expiring LRU cache + Mongo loader for roster backgrounds.
 * A UserBackground document is keyed by owner discordId and stores a small
 * pool of resized JPEG buffers plus stable roster->image assignments.
 */

"use strict";

const UserBackground = require("../../models/userBackground");
const { createInFlightLoader } = require("../../utils/async/in-flight-loader");
const { createMemoryCache } = require("../../utils/cache/memory-cache");

// Roster pages for one owner share overlapping reads, but every later render
// still checks Mongo's version. Completed documents are never cached here.
const loadBackgroundMeta = createInFlightLoader((discordId) =>
  UserBackground.findOne({ discordId }).select("updatedAt").lean()
);
const loadBackgroundData = createInFlightLoader((discordId) =>
  UserBackground.findOne({ discordId })
    .select("images assignments mode imageData updatedAt").lean()
);

const CACHE_CAP = 40;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = createMemoryCache({
  maxBytes: CACHE_MAX_BYTES,
  maxEntries: CACHE_CAP,
  ttlMs: CACHE_TTL_MS,
  sizeOf: (entry) => entry.buffer.length,
});

function normalizeAccountKey(accountName) {
  return String(accountName || "").trim().toLowerCase();
}

/**
 * Preserve Buffer identity while accepting Mongo's stored binary shape.
 * @param {Buffer|object|null} value Stored image bytes.
 * @returns {Buffer|null} Image buffer or null when absent.
 */
function bufferFromStored(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer || value);
}

function hashString(value) {
  let hash = 0;
  const text = normalizeAccountKey(value);
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getDocUpdatedAt(doc, fallback = 0) {
  const value = doc?.updatedAt;
  if (!value) return fallback;
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Read the current image library or the legacy single-image document.
 * @param {object|null} doc Stored background document.
 * @returns {object[]} Image records in their persisted order.
 */
function getStoredImages(doc) {
  if (Array.isArray(doc?.images) && doc.images.length > 0) {
    return doc.images;
  }
  // Legacy compatibility for the one-image Mongo storage shape used before
  // roster-aware pools landed.
  if (doc?.imageData) {
    return [doc];
  }
  return [];
}

function selectImageIndex(doc, accountName) {
  const images = getStoredImages(doc);
  if (images.length === 0) return -1;

  const accountKey = normalizeAccountKey(accountName);
  if (accountKey && Array.isArray(doc?.assignments)) {
    const found = doc.assignments.find((entry) => entry.accountKey === accountKey);
    if (
      found
      && Number.isInteger(found.imageIndex)
      && found.imageIndex >= 0
      && found.imageIndex < images.length
    ) {
      return found.imageIndex;
    }
  }

  if (doc?.mode === "random") {
    return Math.floor(Math.random() * images.length);
  }

  return accountKey ? hashString(accountKey) % images.length : 0;
}

/**
 * @param {string} discordId Background owner.
 * @param {{accountName?: string}} [options] Roster used to select the image.
 * @returns {Promise<Buffer|null>} Current background, or null when unavailable.
 */
async function loadBackgroundBuffer(discordId, options = {}) {
  if (!discordId) return null;
  const accountName = options.accountName || "";
  const accountKey = normalizeAccountKey(accountName);
  const cacheKey = `${discordId}:${accountKey}`;

  let metaUpdatedAt = 0;
  // Without a cached buffer, the full document is needed anyway and includes
  // its version. Cached images still get a fresh, small version query first.
  if (cache.get(cacheKey)) {
    try {
      const meta = await loadBackgroundMeta(discordId);
      if (!meta) {
        cache.delete(cacheKey);
        return null;
      }
      metaUpdatedAt = getDocUpdatedAt(meta);
    } catch (err) {
      console.warn(`[raid-card bg-loader] meta read failed for ${discordId}:`, err.message);
      return null;
    }

    const cached = cache.get(cacheKey);
    if (cached && cached.updatedAt === metaUpdatedAt) {
      return cached.buffer;
    }
  }

  try {
    const doc = await loadBackgroundData(discordId);
    const images = getStoredImages(doc);
    if (images.length === 0) {
      cache.delete(cacheKey);
      return null;
    }
    const selected = images[selectImageIndex(doc, accountName)] || images[0];
    const buffer = bufferFromStored(selected.imageData);
    if (!buffer) {
      cache.delete(cacheKey);
      return null;
    }

    const entry = { updatedAt: getDocUpdatedAt(doc, metaUpdatedAt), buffer };
    cache.set(cacheKey, entry);
    return buffer;
  } catch (err) {
    console.warn(`[raid-card bg-loader] data read failed for ${discordId}:`, err.message);
    return null;
  }
}

/**
 * @param {string} [discordId] Owner to invalidate; omitted clears all backgrounds.
 * @returns {void}
 */
function clearBackgroundCache(discordId) {
  if (!discordId) {
    cache.clear();
    loadBackgroundMeta.clear();
    loadBackgroundData.clear();
    return;
  }
  loadBackgroundMeta.invalidate(discordId);
  loadBackgroundData.invalidate(discordId);
  const prefix = `${discordId}:`;
  cache.invalidate((key) => key === discordId || key.startsWith(prefix));
}

module.exports = {
  loadBackgroundBuffer,
  clearBackgroundCache,
  normalizeAccountKey,
  bufferFromStored,
  getStoredImages,
  _cache: cache,
  _CACHE_CAP: CACHE_CAP,
  _selectImageIndex: selectImageIndex,
};
