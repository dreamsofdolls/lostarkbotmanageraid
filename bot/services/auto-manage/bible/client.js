"use strict";

const { createBibleCharacterNotFoundError } = require("./error-kinds");
const { createBibleHttpError } = require("./rate-limit");
const { getClassName } = require("../../../models/Class");
const {
  BIBLE_ORIGIN,
  BIBLE_REGION,
  BIBLE_REQUEST_TIMEOUT_MS,
} = require("../../bible-endpoint");

const BIBLE_USER_AGENT = "Mozilla/5.0 (compatible; LostArkRaidManageBot/1.0)";
const DEFAULT_MAX_LOG_PAGES = 10;
const MAX_CHARACTER_HTML_BYTES = 8 * 1024 * 1024;
const MAX_IDENTITY_SCAN_LENGTH = 64 * 1024;

function defaultFetch(...args) {
  return fetch(...args);
}

function createRequestSignal(signal) {
  const timeout = AbortSignal.timeout(BIBLE_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readCharacterHtml(res, charName, includeProfile) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let overlap = "";
  let metadataText;
  let hasMetadata = false;
  let hasHeaderEnd = false;
  let hasProfileTitle = !includeProfile;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return chunks.join("") + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_CHARACTER_HTML_BYTES) throw new Error(`Bible roster page exceeded 8 MiB for "${charName}"`);
      const decoded = decoder.decode(value, { stream: true });
      chunks.push(decoded);
      const fragment = overlap + decoded;
      let headerFragment = fragment;
      if (metadataText === undefined) {
        const start = fragment.indexOf("header:{id:");
        if (start >= 0) metadataText = headerFragment = fragment.slice(start);
      } else if (!hasMetadata) metadataText += decoded;
      if (metadataText !== undefined) {
        // A digit at a chunk boundary may still belong to an unfinished rid.
        hasMetadata ||= /header:\{id:(\d+),sn:"([^"]+)",rid:(\d+)(?=[,}\s])/.test(metadataText.slice(0, MAX_IDENTITY_SCAN_LENGTH));
        hasHeaderEnd ||= headerFragment.includes("redirectedFrom:");
        if (hasMetadata) metadataText = "";
        // Long or changed headers fall back to the bounded full-page parser
        // instead of rescanning an ever-growing candidate after every chunk.
        else if (metadataText.length > MAX_IDENTITY_SCAN_LENGTH) metadataText = undefined;
      }
      if (!hasProfileTitle && bytes <= MAX_IDENTITY_SCAN_LENGTH && fragment.includes("</title>")) {
        hasProfileTitle = /<title>[^<]+ \(NA\) \| lostark\.bible<\/title>/.test(chunks.join(""));
      }
      // Fixed markers can cross chunks; unrelated HTML needs only this overlap.
      overlap = fragment.slice(-"redirectedFrom:".length + 1);
      if (hasMetadata && (!includeProfile || (hasHeaderEnd && hasProfileTitle))) {
        // The remaining roster cards are irrelevant to this character's identity.
        return chunks.join("");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Fetch a character's lostark.bible identifiers (serial / cid / rid) by
 * loading their roster page and regex-extracting the SSR SvelteKit bootstrap
 * data. These IDs are required to call the logs API but only need to be
 * fetched once per character - caller caches them on the character doc.
 */
async function fetchBibleCharacterPage(charName, { fetchImpl = defaultFetch, signal } = {}, includeProfile = false) {
  const url = `${BIBLE_ORIGIN}/character/${BIBLE_REGION}/${encodeURIComponent(charName)}/roster`;
  const res = await fetchImpl(url, {
    headers: {
      "User-Agent": BIBLE_USER_AGENT,
      Accept: "text/html",
    },
    // Timeout guards against bible hanging the connection: without it, a
    // stuck fetch holds the bible limiter slot and the caller's in-flight
    // guard indefinitely.
    signal: createRequestSignal(signal),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw createBibleHttpError(
      `Bible roster page returned HTTP ${res.status} for "${charName}"`,
      res
    );
  }
  const html = await readCharacterHtml(res, charName, includeProfile);
  // SSR SvelteKit bootstrap data: {header:{id:<cid>,sn:"<serial>",rid:<rid>,...}}
  const match = html.match(/header:\{id:(\d+),sn:"([^"]+)",rid:(\d+)/);
  if (!match) {
    // The "Character Not Found" page carries `header:void 0` in the same data.
    if (html.includes("header:void 0")) throw createBibleCharacterNotFoundError(charName);
    throw new Error(`Could not parse bible metadata for "${charName}" (page shape changed?)`);
  }
  return { html, meta: { cid: Number(match[1]), sn: match[2], rid: Number(match[3]) } };
}

async function fetchBibleCharacterMeta(charName, options) {
  return (await fetchBibleCharacterPage(charName, options)).meta;
}

// The same page contains both identity and class. /raid-log does not need to
// fetch it again or parse every roster card to resolve one character.
async function fetchBibleCharacterProfile(charName, options) {
  const { html, meta } = await fetchBibleCharacterPage(charName, options, true);
  const name = html.match(/<title>([^<]+) \(NA\) \| lostark\.bible<\/title>/)?.[1];
  const headerStart = html.indexOf("header:{id:");
  const headerEnd = html.indexOf("redirectedFrom:", headerStart);
  const classId = headerEnd > headerStart
    ? html.slice(headerStart, headerEnd).match(/\bclass:"([^"]+)"/)?.[1]
    : null;
  if (!name || !classId) throw new Error(`Could not parse bible profile for "${charName}" (page shape changed?)`);
  return { ...meta, name, className: getClassName(classId) };
}

/**
 * Call lostark.bible's logs REST API. Returns the raw array of log entries
 * (max 25 per page). Each entry shape: { id, name, boss, difficulty, dps,
 * class, spec, gearScore, combatPower, percentile, duration, timestamp,
 * isBus, isDead }.
 */
async function fetchBibleCharacterLogs(
  { serial, cid, rid, className, page = 1 },
  { fetchImpl = defaultFetch, signal } = {}
) {
  const url = `${BIBLE_ORIGIN}/api/character/logs`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": BIBLE_USER_AGENT,
    },
    body: JSON.stringify({
      region: BIBLE_REGION,
      characterSerial: serial,
      className,
      cid,
      rid,
      page,
    }),
    // Same hang-protection rationale as fetchBibleCharacterMeta().
    signal: createRequestSignal(signal),
  });
  if (!res.ok) {
    // Read body so callers can distinguish "Logs not enabled" (private char,
    // user action fixes it) from Cloudflare/block 403s (bot-infra issue,
    // toggling Public Log won't help). See reference_bible_api.md.
    let bodyText;
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    const snippet = bodyText ? ` - ${bodyText.slice(0, 200).replace(/\s+/g, " ").trim()}` : "";
    const err = createBibleHttpError(
      `Bible logs API returned HTTP ${res.status}${snippet}`,
      res
    );
    err.bodyText = bodyText;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function freshUniqueLogs(logs, seenLogIds) {
  const freshLogs = [];
  for (const log of logs || []) {
    const id = String(log?.id || "").trim();
    const dedupeKey = id || `${log?.timestamp || ""}:${log?.name || ""}:${log?.boss || ""}`;
    if (!dedupeKey || seenLogIds.has(dedupeKey)) continue;
    seenLogIds.add(dedupeKey);
    freshLogs.push(log);
  }
  return freshLogs;
}

function createBibleClient({ bibleLimiter, fetchImpl = defaultFetch }) {
  if (!bibleLimiter || typeof bibleLimiter.run !== "function") {
    throw new Error("[auto-manage-bible-client] bibleLimiter with run() is required");
  }

  async function runRequest(request, { signal } = {}) {
    signal?.throwIfAborted();
    return bibleLimiter.run(() => {
      // A caller can expire while its request waits behind other Bible work.
      signal?.throwIfAborted();
      return request({ fetchImpl, signal });
    }, { signal });
  }

  function fetchBibleLogsWithLimiter(args, options) {
    return runRequest(request => fetchBibleCharacterLogs(args, request), options);
  }

  // Route the meta HTML scrape through the same limiter the logs API uses so a
  // cold-cache sync (N chars, each needing both meta + logs) can't double
  // bible's effective concurrency.
  function fetchBibleCharacterMetaWithLimiter(charName, options) {
    return runRequest(request => fetchBibleCharacterMeta(charName, request), options);
  }

  function fetchBibleCharacterProfileWithLimiter(charName, options) {
    return runRequest(request => fetchBibleCharacterProfile(charName, request), options);
  }

  /**
   * Paginate Bible's logs API until an entry is older than `weekResetStart`,
   * a page is empty, or `maxPages` is reached. Bible returns
   * newest-first with 25 entries per page, so one pre-reset entry in a
   * page means every deeper page is irrelevant.
   */
  async function fetchBibleLogsSinceWeekReset({
    serial,
    cid,
    rid,
    className,
    weekResetStart,
    maxPages = DEFAULT_MAX_LOG_PAGES,
  }) {
    const all = [];
    const seenLogIds = new Set();
    for (let page = 1; page <= maxPages; page += 1) {
      const logs = await fetchBibleLogsWithLimiter({ serial, cid, rid, className, page });
      if (!Array.isArray(logs) || logs.length === 0) break;
      const freshLogs = freshUniqueLogs(logs, seenLogIds);
      if (freshLogs.length === 0) break;
      all.push(...freshLogs);
      // If any log in this page is before the reset boundary, deeper pages
      // only contain older entries - stop early.
      const hasPreReset = freshLogs.some((log) => Number(log?.timestamp) < weekResetStart);
      if (hasPreReset) break;
      // Partial page = last page bible has.
      if (logs.length < 25) break;
    }
    return all;
  }

  return {
    fetchBibleCharacterMetaWithLimiter,
    fetchBibleCharacterProfileWithLimiter,
    fetchBibleLogsSinceWeekReset,
    fetchBibleLogsWithLimiter,
  };
}

module.exports = {
  createBibleClient,
};
