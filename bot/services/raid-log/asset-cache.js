"use strict";

const { promisify } = require("node:util");
const { brotliCompress, brotliDecompress, constants } = require("node:zlib");
const { BIBLE_ORIGIN } = require("./source");
const { createMemoryCache } = require("./memory-cache");

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MIN_COMPRESS_BYTES = 4 * 1024;
const MAX_PENDING_ASSETS = 64;

function isImmutableAsset(request) {
  if (request.method() !== "GET" || request.isNavigationRequest()) return false;
  const url = new URL(request.url());
  return url.origin === BIBLE_ORIGIN && !url.username && !url.password && !url.search
    && url.pathname.startsWith("/_app/immutable/") && /\.(?:js|css|woff2?)$/.test(url.pathname);
}

/**
 * Routing disables Chromium's HTTP cache. Retain only Bible's public,
 * immutable app assets across navigations and short browser lifetimes.
 * @returns {{ get: Function, remember: Function, fulfill: Function, clear: Function }} bounded static-asset cache
 */
function createAssetCache() {
  const cache = createMemoryCache({ maxBytes: 4 * 1024 * 1024, maxEntries: 128, ttlMs: 5 * 60_000,
    sizeOf: asset => asset.body.length });
  let pending = Promise.resolve();
  let fulfilling = Promise.resolve();
  let generation = 0;
  const queued = new Set();
  return {
    get(request) {
      return isImmutableAsset(request) ? cache.get(request.url()) : undefined;
    },
    remember(response) {
      if (response.status() !== 200 || !isImmutableAsset(response.request()) || cache.get(response.url())) return;
      const url = response.url();
      if (queued.has(url) || queued.size >= MAX_PENDING_ASSETS) return;
      const current = generation;
      queued.add(url);
      // Read one decoded response at a time instead of copying every module
      // into Node while the page is still loading.
      pending = pending.then(async () => {
        if (current !== generation) return;
        const headers = await response.allHeaders();
        const policy = headers["cache-control"] || "";
        const maxAge = Number(/(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(policy)?.[1]);
        const expires = Date.now() + (maxAge - Number(headers.age || 0)) * 1000;
        if (!/\bpublic\b/i.test(policy) || !/\bimmutable\b/i.test(policy)
          || /\b(?:private|no-store|no-cache)\b/i.test(policy) || headers["set-cookie"]
          || !/^(?:text\/(?:javascript|css)|application\/(?:javascript|x-javascript)|font\/woff2?)(?:;|$)/i.test(headers["content-type"] || "")
          || (headers.vary && headers.vary.toLowerCase() !== "accept-encoding")
          || Number(headers["content-length"]) > MAX_ASSET_BYTES || !(expires > Date.now())) return;
        const body = await response.body();
        if (current !== generation || body.length > MAX_ASSET_BYTES) return;
        const asset = { status: 200, contentType: headers["content-type"], body };
        // Large app modules fit the small cache in compressed form.
        if (body.length > MIN_COMPRESS_BYTES && !asset.contentType.startsWith("font/")) {
          const encoded = await compress(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
          if (encoded.length < body.length) {
            asset.body = encoded;
            asset.encoding = "br";
          }
        }
        if (current === generation) cache.set(url, asset, expires - Date.now());
      }).catch(() => {
        // Navigation or browser disposal may discard a body before it is read.
        // The next request continues through the original network route.
      }).finally(() => { if (current === generation) queued.delete(url); });
      return pending;
    },
    fulfill(route, asset) {
      const current = generation;
      // Fetch fulfillment expects decoded bodies. Keep only one decoded
      // module alive until Chromium accepts it, even during parallel imports.
      const delivered = fulfilling.then(async () => {
        if (current !== generation) return route.abort();
        const body = asset.encoding === "br" ? await decompress(asset.body, { maxOutputLength: MAX_ASSET_BYTES }) : asset.body;
        await route.fulfill({ status: asset.status, contentType: asset.contentType, body });
      });
      fulfilling = delivered.catch(() => {});
      return delivered;
    },
    clear() {
      generation++;
      cache.clear();
      queued.clear();
    },
  };
}

module.exports = { createAssetCache };
