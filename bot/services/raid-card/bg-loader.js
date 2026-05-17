/**
 * services/raid-card/bg-loader.js
 *
 * In-memory LRU cache + Mongo loader for roster-aware background buffers.
 * A UserBackground document is keyed by owner discordId and stores a small
 * pool of resized JPEG buffers plus stable roster->image assignments.
 */

"use strict";

const UserBackground = require("../../models/userBackground");

const CACHE_CAP = 40;

const cache = new Map();

function normalizeAccountKey(accountName) {
  return String(accountName || "").trim().toLowerCase();
}

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

function touch(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
}

function evictIfFull() {
  while (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
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

async function loadBackgroundBuffer(discordId, options = {}) {
  if (!discordId) return null;
  const accountName = options.accountName || "";
  const accountKey = normalizeAccountKey(accountName);
  const cacheKey = `${discordId}:${accountKey}`;

  let metaUpdatedAt;
  try {
    const meta = await UserBackground.findOne({ discordId })
      .select("updatedAt")
      .lean();
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
    touch(cacheKey, cached);
    return cached.buffer;
  }

  try {
    const doc = await UserBackground.findOne({ discordId })
      .select("images assignments mode imageData updatedAt")
      .lean();
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
    evictIfFull();
    cache.set(cacheKey, entry);
    return buffer;
  } catch (err) {
    console.warn(`[raid-card bg-loader] data read failed for ${discordId}:`, err.message);
    return null;
  }
}

function clearBackgroundCache(discordId) {
  if (!discordId) {
    cache.clear();
    return;
  }
  const prefix = `${discordId}:`;
  for (const key of Array.from(cache.keys())) {
    if (key === discordId || key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

module.exports = {
  loadBackgroundBuffer,
  clearBackgroundCache,
  normalizeAccountKey,
  _cache: cache,
  _CACHE_CAP: CACHE_CAP,
  _selectImageIndex: selectImageIndex,
};
