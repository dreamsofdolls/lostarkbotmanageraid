"use strict";

const BIBLE_REGION = "NA";
const BIBLE_USER_AGENT = "Mozilla/5.0 (compatible; LostArkRaidManageBot/1.0)";
const BIBLE_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MAX_LOG_PAGES = 10;

function defaultFetch(...args) {
  return fetch(...args);
}

function createRequestSignal() {
  return AbortSignal.timeout(BIBLE_REQUEST_TIMEOUT_MS);
}

/**
 * Fetch a character's lostark.bible identifiers (serial / cid / rid) by
 * loading their roster page and regex-extracting the SSR SvelteKit bootstrap
 * data. These IDs are required to call the logs API but only need to be
 * fetched once per character - caller caches them on the character doc.
 */
async function fetchBibleCharacterMeta(charName, { fetchImpl = defaultFetch } = {}) {
  const url = `https://lostark.bible/character/${BIBLE_REGION}/${encodeURIComponent(charName)}/roster`;
  const res = await fetchImpl(url, {
    headers: {
      "User-Agent": BIBLE_USER_AGENT,
      Accept: "text/html",
    },
    // Timeout guards against bible hanging the connection: without it, a
    // stuck fetch holds the bible limiter slot and the caller's in-flight
    // guard indefinitely.
    signal: createRequestSignal(),
  });
  if (!res.ok) {
    throw new Error(`Bible roster page returned HTTP ${res.status} for "${charName}"`);
  }
  const html = await res.text();
  // SSR SvelteKit bootstrap data: {header:{id:<cid>,sn:"<serial>",rid:<rid>,...}}
  const match = html.match(/header:\{id:(\d+),sn:"([^"]+)",rid:(\d+)/);
  if (!match) {
    throw new Error(`Could not parse bible metadata for "${charName}" (page shape changed?)`);
  }
  return { cid: Number(match[1]), sn: match[2], rid: Number(match[3]) };
}

/**
 * Call lostark.bible's logs REST API. Returns the raw array of log entries
 * (max 25 per page). Each entry shape: { id, name, boss, difficulty, dps,
 * class, spec, gearScore, combatPower, percentile, duration, timestamp,
 * isBus, isDead }.
 */
async function fetchBibleCharacterLogs(
  { serial, cid, rid, className, page = 1 },
  { fetchImpl = defaultFetch } = {}
) {
  const url = "https://lostark.bible/api/character/logs";
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
    signal: createRequestSignal(),
  });
  if (!res.ok) {
    // Read body so callers can distinguish "Logs not enabled" (private char,
    // user action fixes it) from Cloudflare/block 403s (bot-infra issue,
    // toggling Public Log won't help). See reference_bible_api.md.
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    const snippet = bodyText ? ` - ${bodyText.slice(0, 200).replace(/\s+/g, " ").trim()}` : "";
    const err = new Error(`Bible logs API returned HTTP ${res.status}${snippet}`);
    err.status = res.status;
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

  function fetchBibleLogsWithLimiter(args) {
    return bibleLimiter.run(() => fetchBibleCharacterLogs(args, { fetchImpl }));
  }

  // Route the meta HTML scrape through the same limiter the logs API uses so a
  // cold-cache sync (N chars, each needing both meta + logs) can't double
  // bible's effective concurrency.
  function fetchBibleCharacterMetaWithLimiter(charName) {
    return bibleLimiter.run(() => fetchBibleCharacterMeta(charName, { fetchImpl }));
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
    fetchBibleLogsSinceWeekReset,
    fetchBibleLogsWithLimiter,
  };
}

module.exports = {
  BIBLE_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_LOG_PAGES,
  createBibleClient,
  fetchBibleCharacterLogs,
  fetchBibleCharacterMeta,
};
