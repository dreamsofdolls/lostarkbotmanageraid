// Local Sync web companion - Phase 4.5 (streaming SQLite via wa-sqlite).
//
// Architecture choices:
//   - vanilla JS (no React/Next/Vite). The page does 5 things: parse
//     URL token, set active i18n language, FSA permission, sql.js query,
//     POST sync. Adding a framework would ship 100kB+ of runtime for
//     ~280 LOC of logic.
//   - wa-sqlite (asyncify build) loaded from jsdelivr. We use a custom
//     async VFS (web/file-vfs.js) that streams from File.slice() so
//     multi-GB encounters.db files don't blow Chrome's ArrayBuffer cap
//     (sql.js, the previous library, required full-file load and broke
//     at 4 GB with NotReadableError).
//   - SQLite only fetches the B-tree pages it needs - tens of MB even
//     on a 4 GB DB. Schema-detection via PRAGMA table_info adapts the
//     query to whichever LOA Logs version wrote the file.
//   - Active locale comes from the JWT token payload (`lang` field
//     minted by the bot). web/i18n.js + web/locales.js power the
//     vi/jp/en string swap. data-i18n attributes in index.html drive
//     the static-text swap; dynamic UI strings call t() inline.

"use strict";

import {
  setActiveLang,
  applyDomTranslations,
  t,
  getRaidLabel,
  getModeLabel,
} from "/sync/i18n.js";
import {
  saveHandle as savePersistedHandle,
  clearHandle as clearPersistedHandle,
  tryRestoreForUser,
} from "/sync/file-persistence.js";

const $ = (id) => document.getElementById(id);
const authStatus = $("auth-status");
const fileSection = $("file-section");
const previewSection = $("preview-section");
const dropZone = $("drop-zone");
const pickFileBtn = $("pick-file-btn");
const fileMeta = $("file-meta");
const previewOutput = $("preview-output");
const syncSection = $("sync-section");
const syncBtn = $("sync-btn");
const syncOutput = $("sync-output");

// Cache the last successful query result so the Sync button can POST it
// without re-running the SQL. Set on every loadAndPreview() success.
let lastDeltas = null;

// LA VN raid week boundary helper. Reset is Wed 17:00 VN = 10:00 UTC.
// Returns {start, endDisplay} as Date objects. start = most recent reset
// moment <= now; endDisplay = 6 days later (the Tue before next reset)
// so the displayed range reads as a "Wed → Tue" full cycle.
function getCurrentRaidWeek() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const utcHour = now.getUTCHours();
  let daysBack;
  if (dayOfWeek > 3 || (dayOfWeek === 3 && utcHour >= 10)) {
    daysBack = dayOfWeek - 3;
  } else {
    daysBack = dayOfWeek + 4;
  }
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysBack,
    10, 0, 0, 0
  ));
  const endDisplay = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  return { start, endDisplay };
}

function formatWeekDate(d, lang) {
  const localeMap = { vi: "vi-VN", jp: "ja-JP", en: "en-US" };
  const locale = localeMap[lang] || "vi-VN";
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
  }).format(d);
}

function renderWeekRange() {
  const el = document.getElementById("preview-week-range");
  if (!el) return;
  const { start, endDisplay } = getCurrentRaidWeek();
  const lang = window.__artistLang || "vi";
  el.innerHTML = t("preview.weekRange", {
    start: formatWeekDate(start, lang),
    end: formatWeekDate(endDisplay, lang),
  });
  el.hidden = false;
}

// ----- 1. Token parsing + i18n bootstrap -----
//
// Token is decoded inline (no fetch) since it carries Discord ID + lang
// + expiry signed by the bot's HMAC secret. The decode is presentational
// only (server re-verifies on every POST) so we just need the payload
// fields, not crypto-trust.

const params = new URLSearchParams(window.location.search);
const token = params.get("token");

function decodePayload(t) {
  try {
    const parts = t.split(".");
    if (parts.length !== 2) return null;
    const normalized = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

const payload = token ? decodePayload(token) : null;

// Resolve the active language BEFORE rendering anything user-facing.
// Token's `lang` field is the bot-side getUserLanguage(discordId) result
// at mint time. Falls back to vi (User.language schema default) when:
//   - no token present (page opened without /raid-auto-manage local-on)
//   - token is malformed (bad payload)
//   - token doesn't carry lang (legacy mint before Phase i18n)
setActiveLang(payload?.lang || "vi");
applyDomTranslations();
renderWeekRange();

// Static <html lang> + <body dir> attributes follow the active locale so
// fonts + line-breaking heuristics match. JP/Chinese-derived glyphs in
// particular benefit from the right `lang` hint for browser font fallback.
document.documentElement.setAttribute("lang", window.__artistLang || "vi");

// authState carries everything renderAuthStatus() needs. The expSec field
// is mutable - successful sync shrinks it to now+60s server-side, and the
// sync response hands the new value back so the UI ticks down realtime.
//
// `discordId` stays in state because backend POSTs need it via the token,
// but it is NEVER rendered to the DOM (would leak the user's snowflake to
// anyone shoulder-surfing). The display uses `username` + `avatarUrl`
// from the token payload instead - both are public-facing Discord fields.
let authState = null;

function renderAuthStatus() {
  if (!authState) return;
  const { kind, expSec, username, avatarUrl } = authState;
  if (kind === "noToken") {
    authStatus.innerHTML = `<span class="status-err">${t("identity.noToken")}</span> ${t("identity.noTokenHint")}`;
    return;
  }
  if (kind === "malformed") {
    authStatus.innerHTML = `<span class="status-err">${t("identity.malformed")}</span> ${t("identity.malformedHint")}`;
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const remSec = Math.max(0, expSec - nowSec);
  if (expSec && remSec === 0) {
    authStatus.innerHTML = `<span class="status-err">${t("identity.expired")}</span> ${t("identity.expiredHint")}`;
    return;
  }
  const validStr = remSec >= 60
    ? t("identity.tokenValid", { n: Math.floor(remSec / 60) })
    : t("identity.tokenValidSec", { n: remSec });
  // Profile chip: avatar + display name. Falls back to anonymous "Linked"
  // when an older token (pre-profile-mint) carries neither field - we
  // still want users on stale URLs to see SOMETHING confirming the link.
  let chip;
  if (username || avatarUrl) {
    const avatarImg = avatarUrl
      ? `<img class="auth-avatar" src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer">`
      : "";
    const nameSpan = username ? `<strong>${escapeHtml(username)}</strong>` : "";
    chip = `<span class="status-ok auth-chip">${avatarImg}${t("identity.linked")} ${nameSpan}</span>`;
  } else {
    chip = `<span class="status-ok">${t("identity.linkedAnonymous")}</span>`;
  }
  authStatus.innerHTML = `${chip} · ${validStr}`;
}

if (!token) {
  authState = { kind: "noToken" };
  renderAuthStatus();
} else if (!payload || !payload.discordId) {
  authState = { kind: "malformed" };
  renderAuthStatus();
} else {
  const expSec = payload.exp || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  // username + avatarUrl are display-only. discordId stays in state for
  // POST auth via window.__artistDiscordId but is never read by render.
  const profileFields = {
    username: typeof payload.username === "string" ? payload.username : null,
    avatarUrl: typeof payload.avatarUrl === "string" ? payload.avatarUrl : null,
  };
  if (expSec && expSec < nowSec) {
    authState = { kind: "ok", expSec, discordId: payload.discordId, ...profileFields };
    renderAuthStatus();
  } else {
    authState = { kind: "ok", expSec, discordId: payload.discordId, ...profileFields };
    renderAuthStatus();
    // Tick every second so the countdown feels live (esp. after the
    // post-sync shrink to ~60s). 1Hz is cheap - just a Date.now() compare
    // and innerHTML swap.
    setInterval(renderAuthStatus, 1000);
    // Cache for the eventual POST. Phase 4 reads this back.
    window.__artistSyncToken = token;
    window.__artistDiscordId = payload.discordId;
    fileSection.hidden = false;
  }
}

// ----- 2. FSA file pick / drop -----

async function loadFile(file, { handle = null } = {}) {
  fileMeta.hidden = false;
  // Render file meta + a "Remove" button so the user can detach the
  // file (clears persisted handle from IDB so next visit asks for a
  // fresh pick). Restore action button (when permission was revoked)
  // hides automatically because we re-render this innerHTML.
  fileMeta.innerHTML = `<div class="file-meta-row"><span>${t("file.selected")} <strong>${escapeHtml(file.name)}</strong> · ${formatBytes(file.size)} · ${t("file.modified")} ${new Date(file.lastModified).toLocaleString()}</span><button id="remove-file-btn" type="button" class="remove-file-btn">${escapeHtml(t("file.removeBtn"))}</button></div>`;
  // Wire Remove button - clears persisted handle + resets the UI back
  // to the dropzone state. Doesn't touch the actual file on disk.
  const removeBtn = document.getElementById("remove-file-btn");
  if (removeBtn) {
    removeBtn.addEventListener("click", handleRemoveFile);
  }
  previewSection.hidden = false;
  // Refresh week range in case the page was open across a Wed 17:00
  // VN reset boundary - boot-time render would be stale by then.
  renderWeekRange();
  // Persist the handle for next visit. Plain File (drag-drop without
  // FSA handle promotion) can't persist - skip silently in that case.
  if (handle && window.__artistDiscordId) {
    savePersistedHandle({
      discordId: window.__artistDiscordId,
      handle,
      fileName: file.name,
    }).catch((err) => {
      console.warn("[local-sync] saveHandle failed:", err?.message || err);
    });
  }
  await loadAndPreview(file);
}

async function handleRemoveFile() {
  try {
    await clearPersistedHandle();
  } catch (err) {
    console.warn("[local-sync] clearHandle failed:", err?.message || err);
  }
  // Reset UI back to the dropzone state. previewOutput + sync section
  // hide so user knows nothing's loaded.
  fileMeta.hidden = true;
  fileMeta.innerHTML = "";
  previewSection.hidden = true;
  previewOutput.innerHTML = "";
  syncSection.hidden = true;
  syncOutput.hidden = true;
  syncOutput.innerHTML = "";
  lastDeltas = null;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  // Prefer DataTransferItem.getAsFileSystemHandle() so the resulting
  // FileSystemFileHandle is persistable in IDB. Falls back to plain
  // File for browsers without that API (handle stays null, file works
  // for THIS session but won't survive refresh).
  const item = e.dataTransfer?.items?.[0];
  let handle = null;
  let file = null;
  if (item && typeof item.getAsFileSystemHandle === "function") {
    try {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === "file") {
        handle = h;
        file = await h.getFile();
      }
    } catch (err) {
      console.warn("[local-sync] getAsFileSystemHandle failed:", err?.message || err);
    }
  }
  if (!file) {
    file = e.dataTransfer?.files?.[0];
  }
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".db")) {
    alert(t("file.invalidExt"));
    return;
  }
  await loadFile(file, { handle });
});

pickFileBtn.addEventListener("click", async () => {
  if (typeof window.showOpenFilePicker !== "function") {
    alert(t("file.fsaUnavailable"));
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "LOA Logs encounters DB", accept: { "application/octet-stream": [".db"] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    });
    const file = await handle.getFile();
    await loadFile(file, { handle });
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.error("[local-sync] file pick failed:", err);
    alert(`${t("file.pickFailed")}: ${err.message || err}`);
  }
});

// ----- 2.5. Restore-on-load: try to bring back the previously-picked
// file when the user refreshes the page with the same token. The
// browser's persistent FSA permission ("Allow on every visit") makes
// this seamless when granted; otherwise we surface a Restore button
// that the user clicks to elevate permission inside a user gesture.
async function attemptRestoreFromIdb() {
  if (!window.__artistDiscordId) return;
  let restore;
  try {
    restore = await tryRestoreForUser(window.__artistDiscordId);
  } catch (err) {
    console.warn("[local-sync] restore lookup failed:", err?.message || err);
    return;
  }
  if (!restore) return;
  if (restore.granted) {
    // Permission still valid - load file immediately.
    try {
      const file = await restore.handle.getFile();
      await loadFile(file, { handle: restore.handle });
    } catch (err) {
      console.warn("[local-sync] auto-restore getFile failed:", err?.message || err);
    }
    return;
  }
  // Permission was "Allow once" + revoked, OR "Ask every time". Show a
  // Restore banner with a button. The button click is a user gesture,
  // which lets requestPermission() actually prompt.
  fileMeta.hidden = false;
  fileMeta.innerHTML = `<div class="file-meta-row"><span>${escapeHtml(t("file.restoreBanner", { name: restore.fileName || "encounters.db" }))}</span><button id="restore-file-btn" type="button">${escapeHtml(t("file.restoreBtn"))}</button> <button id="remove-file-btn" type="button" class="remove-file-btn">${escapeHtml(t("file.removeBtn"))}</button></div>`;
  const restoreBtn = document.getElementById("restore-file-btn");
  if (restoreBtn) {
    restoreBtn.addEventListener("click", async () => {
      try {
        const result = await restore.handle.requestPermission({ mode: "read" });
        if (result !== "granted") {
          alert(t("file.restoreDenied"));
          return;
        }
        const file = await restore.handle.getFile();
        await loadFile(file, { handle: restore.handle });
      } catch (err) {
        console.warn("[local-sync] restore-permission failed:", err?.message || err);
        alert(`${t("file.restoreFailed")}: ${err.message || err}`);
      }
    });
  }
  const rmBtn = document.getElementById("remove-file-btn");
  if (rmBtn) rmBtn.addEventListener("click", handleRemoveFile);
}

// Kick off the restore attempt only when an authenticated session is
// active (token decoded -> __artistDiscordId set). No-op otherwise.
if (window.__artistDiscordId) {
  attemptRestoreFromIdb().catch((err) => {
    console.warn("[local-sync] restore attempt threw:", err?.message || err);
  });
}

// ----- 3. wa-sqlite query (streaming VFS) -----
//
// Replaces the previous sql.js full-file load. wa-sqlite + FileBackedVFS
// only reads the SQLite B-tree pages our query actually touches (~tens
// of MB on a 4 GB DB), so file size is no longer a wall. Trade-off: more
// async coordination + asyncify-built WASM is ~700 KB vs sql.js 1.5 MB,
// roughly even.

const WA_SQLITE_VERSION = "1.3.0";
const WA_SQLITE_BASE = `https://cdn.jsdelivr.net/npm/@journeyapps/wa-sqlite@${WA_SQLITE_VERSION}`;

async function loadAndPreview(file) {
  previewOutput.textContent = t("preview.loadingWasm");
  try {
    // Lazy-import every wa-sqlite piece so the page stays light when
    // the user hasn't dropped a file yet. ESM imports are deduped by
    // the browser - downloading once + reusing for subsequent files.
    const [SQLiteESMFactoryModule, SQLiteAPI, FileVfsModule] = await Promise.all([
      import(`${WA_SQLITE_BASE}/dist/wa-sqlite-async.mjs`),
      import(`${WA_SQLITE_BASE}/src/sqlite-api.js`),
      import("/sync/file-vfs.js"),
    ]);
    const SQLiteESMFactory = SQLiteESMFactoryModule.default;
    const { FileBackedVFS } = FileVfsModule;
    const module = await SQLiteESMFactory();
    const sqlite3 = SQLiteAPI.Factory(module);
    // Register a VFS that maps the virtual filename "encounters.db" to
    // the real File the user dropped. SQLite asks for byte ranges via
    // jRead; the VFS streams from file.slice() instead of buffering
    // the whole file in memory.
    const vfs = await FileBackedVFS.create("file-vfs", module, {
      "encounters.db": file,
    });
    sqlite3.vfs_register(vfs, false);
    const db = await sqlite3.open_v2(
      "encounters.db",
      SQLiteAPI.SQLITE_OPEN_READONLY,
      "file-vfs"
    );
    try {
      await runPreviewQuery(sqlite3, db);
    } finally {
      await sqlite3.close(db);
    }
  } catch (err) {
    console.error("[local-sync] sqlite open/query failed:", err);
    previewOutput.innerHTML = `<span class="status-err">${t("preview.openFailed")}</span> ${escapeHtml(err.message || String(err))}<br><span class="hint">${t("preview.openFailedHint")}</span>`;
  }
}

// Query the current LOA Logs preview table first. Recent LOA Logs versions
// moved boss/char/difficulty/clear metadata from `encounter` into
// `encounter_preview`; `encounter` now stores mostly raw damage totals.
// Fall back to the older single-table shape for legacy DBs.
async function runPreviewQuery(sqlite3, db) {
  const previewCols = await listColumns(sqlite3, db, "encounter_preview");
  const encounterCols = await listColumns(sqlite3, db, "encounter");
  if (previewCols.size === 0 && encounterCols.size === 0) {
    previewOutput.innerHTML = `<span class="status-err">${t("preview.noTable")}</span> ${t("preview.noTableHint")}`;
    lastDeltas = [];
    return;
  }
  const source = resolveEncounterSource({ previewCols, encounterCols });
  if (!source) {
    previewOutput.innerHTML = `<span class="status-err">${t("preview.missingCols")}</span><br>${formatSchemaPreview("encounter_preview", previewCols)}<br>${formatSchemaPreview("encounter", encounterCols)}<br><span class="hint">${t("preview.missingColsHint")}</span>`;
    lastDeltas = [];
    return;
  }
  const { table, bossCol, tsCol, charCol, diffCol, clearedCol, playersCol } = source;
  const tableSql = quoteIdent(table);
  const bossSql = quoteIdent(bossCol);
  const tsSql = quoteIdent(tsCol);
  const diffSql = diffCol ? quoteIdent(diffCol) : null;
  const clearedSql = clearedCol ? quoteIdent(clearedCol) : null;
  const charSql = charCol ? quoteIdent(charCol) : null;
  const playersSql = playersCol ? quoteIdent(playersCol) : null;
  // Lazy-load preview-utils once per preview. The reset-window helper is
  // needed before SQL so the DB scan only covers the active raid week.
  const {
    bucketize,
    findUnmappedBosses,
    getRaidGateForBoss,
    buildDiff,
    normalizeDifficulty,
    makeBucketKey,
    buildActionableBucketKeySet,
    collectDiffStateCounts,
    currentWeeklyResetStartMs,
  } = await import("/sync/preview-utils.js");
  const currentWeekStartMs = currentWeeklyResetStartMs();
  const sql = `
    SELECT ${bossSql} AS boss,
           ${diffSql ? `COALESCE(${diffSql}, 'Normal')` : `'Normal'`} AS difficulty,
           ${clearedSql ? clearedSql : `1`} AS cleared,
           ${charSql ? `COALESCE(${charSql}, '')` : `''`} AS char_name,
           COUNT(*) AS n,
           MAX(${tsSql}) AS last_ms,
           ${playersSql ? `COALESCE(MAX(${playersSql}), '')` : `''`} AS players
    FROM ${tableSql}
    WHERE ${tsSql} >= ?
      AND ${bossSql} IS NOT NULL
      AND ${bossSql} != ''
      ${clearedSql ? `AND ${clearedSql} = 1` : ""}
    GROUP BY boss, difficulty, cleared, char_name
    ORDER BY last_ms DESC
    LIMIT 200;
  `;
  const rows = [];
  try {
    await sqlite3.exec(db, sql.replace("?", String(currentWeekStartMs)), (row, _columns) => {
      rows.push(row);
    });
  } catch (err) {
    previewOutput.innerHTML = `<span class="status-err">${t("preview.queryFailed")}</span> ${escapeHtml(err.message || String(err))}<br><span class="hint">Table: <code>${escapeHtml(table)}</code>, boss column: <code>${escapeHtml(bossCol)}</code>, ts column: <code>${escapeHtml(tsCol)}</code>. ${t("preview.queryFailedHint")}</span>`;
    return;
  }
  if (rows.length === 0) {
    previewOutput.innerHTML = `<span class="status-ok">${t("preview.noRecent")}</span> ${t("preview.nothingToSync")}`;
    lastDeltas = [];
    return;
  }
  // Build the deltas array for the Sync POST. Server re-validates +
  // re-buckets, but only mapped raid clears are sent. Failed encounters,
  // non-raid content, and rows without a local character stay client-side.
  const syncRows = rows.filter((r) => r[3] && getRaidGateForBoss(r[0]));
  // Bucketize for diff. Each bucket = (char, raid, mode) collapsed to
  // its highest cleared gate. Server's apply.js does the same - so
  // the preview = what gets persisted.
  const buckets = bucketize(rows);
  const unmappedBosses = findUnmappedBosses(rows);
  // Fetch DB roster snapshot in parallel-friendly fashion (we kicked
  // off the SQLite query already, now we ask the server for current
  // assignedRaids state). buildDiff merges the two streams into the
  // roster-grouped view.
  let rosterAccounts = [];
  let rosterError = "";
  try {
    const resp = await fetch("/api/me/roster", {
      headers: { "Authorization": `Bearer ${window.__artistSyncToken}` },
    });
    const data = await resp.json().catch(() => null);
    if (resp.ok) {
      rosterAccounts = Array.isArray(data?.accounts) ? data.accounts : [];
    } else {
      rosterError = data?.error || `HTTP ${resp.status}`;
      console.warn("[local-sync] roster fetch failed:", resp.status, rosterError);
    }
  } catch (err) {
    rosterError = err?.message || String(err);
    console.warn("[local-sync] roster fetch threw:", err?.message || err);
  }
  const diff = buildDiff(rosterAccounts, buckets);
  const actionableKeys = buildActionableBucketKeySet(diff);
  lastDeltas = syncRows
    .filter((r) => {
      const gateInfo = getRaidGateForBoss(r[0]);
      const modeKey = normalizeDifficulty(r[1]) || "normal";
      return actionableKeys.has(makeBucketKey(r[3], gateInfo.raidKey, modeKey));
    })
    .map((r) => ({
      boss: r[0],
      difficulty: r[1],
      cleared: 1,
      charName: r[3],
      lastClearMs: Number(r[5]) || 0,
    }));
  const syncableBuckets = buckets.filter((b) => actionableKeys.has(makeBucketKey(b.charName, b.raidKey, b.modeKey)));
  // Cache the diff + reset to first page on every fresh preview run.
  // currentRosterPage state lives on window so the pagination buttons
  // (rendered as inline HTML, click-bound after innerHTML write) can
  // mutate it via the helper below.
  window.__artistDiff = diff;
  window.__artistRosterPage = 0;
  window.__artistUnmappedBosses = unmappedBosses;
  window.__artistRosterError = rosterError;
  window.__artistCollectDiffStateCounts = collectDiffStateCounts;
  window.__artistMeta = {
    distinctChars: new Set(syncableBuckets.map((b) => String(b.charName || "").trim().toLowerCase())).size,
    clears: syncableBuckets.length,
    detectedChars: new Set(buckets.map((b) => String(b.charName || "").trim().toLowerCase())).size,
    detectedClears: buckets.length,
    schemaDebug: { table, bossCol, tsCol, charCol: charCol || "-" },
  };
  // Default view = char-first. /raid-status mental model: scan "what
  // has my char done this week". Toggle to raid-first for manager
  // scan "who's done raid X". State persists across roster page flips
  // within the same preview session (re-render reads same window var).
  if (window.__artistViewMode !== "raid" && window.__artistViewMode !== "char") {
    window.__artistViewMode = "char";
  }
  renderDiffPage();
  syncSection.hidden = false;
  syncBtn.disabled = lastDeltas.length === 0;
  if (lastDeltas.length === 0) {
    syncOutput.hidden = false;
    syncOutput.innerHTML = t("sync.nothingToSyncFull");
  } else {
    syncOutput.hidden = true;
  }
}

// Render the full preview-output panel for the current roster page.
// Bound to window.__artistRosterPage so prev/next button clicks just
// mutate that index + re-call this. Re-rendering the whole panel is
// cheap (handful of DOM nodes per raid card) and keeps the click
// handlers fresh after innerHTML rewrites.
function renderDiffPage() {
  const diff = window.__artistDiff || [];
  const meta = window.__artistMeta || { distinctChars: 0, clears: 0, schemaDebug: {} };
  const unmappedBosses = window.__artistUnmappedBosses || [];
  const rosterError = window.__artistRosterError || "";
  let pageIndex = Number(window.__artistRosterPage) || 0;
  if (pageIndex < 0) pageIndex = 0;
  if (pageIndex >= diff.length) pageIndex = Math.max(0, diff.length - 1);
  window.__artistRosterPage = pageIndex;

  const headlineKey = Number(meta.clears) > 0 ? "preview.headlineCount" : "preview.headlineNoSync";
  let html = `<div class="meta">${t(headlineKey, { chars: meta.distinctChars, clears: meta.clears })} <span class="hint">${t("preview.schemaDebug", meta.schemaDebug)}</span></div>`;
  if (Number(meta.detectedClears) > Number(meta.clears)) {
    html += `<div class="hint">${t("preview.detectedCount", { chars: meta.detectedChars || 0, clears: meta.detectedClears || 0 })}</div>`;
  }

  if (diff.length === 0) {
    if (rosterError) {
      html += `<p class="hint" style="margin-top:12px;"><span class="status-err">${t("preview.rosterUnavailable")}</span> ${escapeHtml(rosterError)}</p>`;
    } else if (Number(meta.detectedClears) > 0) {
      html += `<p class="hint" style="margin-top:12px;">${t("preview.noRosterMatched")}</p>`;
    } else {
      html += `<p class="hint" style="margin-top:12px;">${t("preview.noBucketsMatched")}</p>`;
    }
  } else {
    const page = diff[pageIndex];
    html += renderDiffLegend(page);
    const viewMode = window.__artistViewMode === "raid" ? "raid" : "char";
    // Roster pagination header + view toggle. Pagination hides for
    // single-roster users; toggle always shows so the user sees the
    // alternate view exists. Layout: [Prev] [Roster name (X/Y)] [Next] | [View toggle]
    html += `<div class="roster-pagination">`;
    if (diff.length > 1) {
      const prevDisabled = pageIndex === 0 ? "disabled" : "";
      html += `<button class="page-btn" id="roster-prev" ${prevDisabled}>◀</button>`;
    }
    html += `<span class="roster-name">🏛️ ${escapeHtml(page.accountName)}</span>`;
    if (diff.length > 1) {
      html += `<span class="page-counter">${pageIndex + 1}/${diff.length}</span>`;
      const nextDisabled = pageIndex >= diff.length - 1 ? "disabled" : "";
      html += `<button class="page-btn" id="roster-next" ${nextDisabled}>▶</button>`;
    }
    // View toggle button - label shows the OTHER view (click to switch
    // TO that view). Single button instead of two-state radio so the
    // affordance is obvious. /raid-status uses the same one-button
    // toggle pattern between Raid view and Side tasks view.
    const toggleLabel = viewMode === "char" ? t("preview.viewToggleToRaid") : t("preview.viewToggleToChar");
    const toggleEmoji = viewMode === "char" ? "🗂️" : "👤";
    html += `<button class="page-btn view-toggle" id="view-toggle">${toggleEmoji} ${escapeHtml(toggleLabel)}</button>`;
    html += `</div>`;
    // Branch render based on active view mode.
    if (viewMode === "char") {
      // Char-first: one card per char with raid+mode rows inline.
      // Default view since "what has my char done" is the natural
      // mental model when previewing what's about to sync. Cards
      // pack 2-up via the grid wrapper for wide viewports - chars
      // list often runs 6-9 chars per roster, vertical stacking
      // wastes horizontal space.
      html += `<div class="char-cards-grid">`;
      for (const character of page.characters) {
        html += `<div class="char-card">`;
        html += `<div class="char-card-head">${formatCharRowHead(character)}</div>`;
        // Group cells by raidKey so the same raid's modes sit on one
        // row: "Act 4: 🛡️Normal ✓✓  ⚔️Hard ✓✓". Wrap all raid rows
        // in a CSS grid so they sit 2-up on wide viewports (typical
        // case: 2-3 raids, fits 2 across with room to spare) and
        // collapse to 1-up on narrow.
        const cellsByRaid = new Map();
        for (const cell of character.cells) {
          if (!cellsByRaid.has(cell.raidKey)) cellsByRaid.set(cell.raidKey, []);
          cellsByRaid.get(cell.raidKey).push(cell);
        }
        html += `<div class="char-raid-grid">`;
        for (const [raidKey, raidCells] of cellsByRaid) {
          const raidLabel = getRaidLabel(raidKey);
          html += `<div class="char-raid-row">`;
          html += `<span class="char-raid-name">${escapeHtml(raidLabel)}</span>`;
          html += `<div class="char-raid-modes">`;
          for (const cell of raidCells) {
            const modeLabel = getModeLabel(cell.modeKey);
            const modeEmoji = cell.modeKey === "nightmare" ? "🌑" : cell.modeKey === "hard" ? "⚔️" : "🛡️";
            html += `<div class="char-mode-block">`;
            html += `<span class="char-mode-label">${modeEmoji} ${escapeHtml(modeLabel)}</span>`;
            html += `<div class="gate-badges">`;
            for (const gate of cell.gates) {
              html += renderGateBadge(gate, cell.states[gate]);
            }
            html += `</div>`;
            html += `</div>`;
          }
          html += `</div>`;
          html += `</div>`;
        }
        html += `</div>`;
        html += `</div>`;
      }
      html += `</div>`; // close .char-cards-grid
    } else {
      // Raid-first: raid-card layout (Phase 7 first cut). Best for
      // "who in this account cleared raid X" Manager-scan flow.
      for (const card of page.raidCards) {
        const raidLabel = getRaidLabel(card.raidKey);
        const modeLabel = getModeLabel(card.modeKey);
        const cardEmoji = card.modeKey === "nightmare" ? "🌑" : card.modeKey === "hard" ? "⚔️" : "🛡️";
        html += `<div class="raid-card">`;
        html += `<h4 class="raid-card-header">${cardEmoji} ${escapeHtml(raidLabel)} ${escapeHtml(modeLabel)} <span class="hint">· ${t("preview.raidGroupCharCount", { n: card.chars.length })}</span></h4>`;
        for (const char of card.chars) {
          html += `<div class="raid-card-char">`;
          html += `<div class="char-info">${formatCharRowHead(char)}</div>`;
          html += `<div class="gate-badges">`;
          for (const gate of char.gates) {
            const state = char.states[gate];
            html += renderGateBadge(gate, state);
          }
          html += `</div>`;
          html += `</div>`;
        }
        html += `</div>`;
      }
    }
  }

  // Unmapped folded into <details> at the bottom so the main view
  // stays focused on "what will sync". Manager / debug surface when
  // a user wants to see why their count is lower than expected.
  if (unmappedBosses.length > 0) {
    html += `<details class="footer-details"><summary>${t("preview.unmappedSummary", { n: unmappedBosses.length })}</summary>`;
    html += `<ul>`;
    for (const boss of unmappedBosses) {
      html += `<li><code>${escapeHtml(boss)}</code></li>`;
    }
    html += `</ul>`;
    html += `<p class="hint">${t("preview.unmappedReportHint")}</p>`;
    html += `</details>`;
  }
  previewOutput.innerHTML = html;

  // Re-bind pagination handlers after each render. They mutate the
  // global page index + re-call this function. Cheap because diff is
  // already in memory.
  const prevBtn = document.getElementById("roster-prev");
  const nextBtn = document.getElementById("roster-next");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      window.__artistRosterPage = Math.max(0, (window.__artistRosterPage || 0) - 1);
      renderDiffPage();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const total = (window.__artistDiff || []).length;
      window.__artistRosterPage = Math.min(total - 1, (window.__artistRosterPage || 0) + 1);
      renderDiffPage();
    });
  }
  // View-toggle button: flip char-first <-> raid-first. Cheap because
  // the underlying diff already carries both projections (preview-utils
  // computes them in one pass), render just picks the right one.
  const viewToggleBtn = document.getElementById("view-toggle");
  if (viewToggleBtn) {
    viewToggleBtn.addEventListener("click", () => {
      window.__artistViewMode = window.__artistViewMode === "raid" ? "char" : "raid";
      renderDiffPage();
    });
  }
}

function formatCharRowHead(character) {
  const cls = character.class || "";
  // Class icon path mirrors preview-utils.js getClassInfoForChar - same
  // /sync/class-icons/<name>.png convention. Class name match is text-
  // based since the roster character.class field is the human label
  // (e.g. "Berserker") not the LOA Logs class_id integer.
  const iconName = CLASS_LABEL_TO_ICON[cls] || "";
  const icon = iconName
    ? `<img class="class-icon" src="/sync/class-icons/${iconName}.png" alt="${escapeHtml(cls)}" title="${escapeHtml(cls)}" loading="lazy">`
    : "";
  return `<span class="char-cell">${icon}<strong>${escapeHtml(character.name)}</strong> <span class="hint">· ${character.itemLevel}</span></span>`;
}

// Reverse map: roster character.class is human-readable ("Berserker") but
// our class-icon files are slugged ("berserker"). Keep this small + in
// sync with preview-utils.js CLASS_ICON_BY_ID values (same slug set).
const CLASS_LABEL_TO_ICON = {
  Berserker: "berserker", Destroyer: "destroyer", Gunlancer: "warlord", Paladin: "holyknight",
  Slayer: "berserker_female", Valkyrie: "holyknight_female",
  Arcanist: "arcana", Summoner: "summoner", Bard: "bard", Sorceress: "elemental_master",
  Wardancer: "battle_master", Scrapper: "infighter", Soulfist: "soulmaster", Glaivier: "lance_master",
  Striker: "battle_master_male", Breaker: "infighter_male",
  Deathblade: "blade", Shadowhunter: "demonic", Reaper: "reaper", Souleater: "soul_eater",
  Sharpshooter: "hawk_eye", Deadeye: "devil_hunter", Artillerist: "blaster", Machinist: "scouter",
  Gunslinger: "devil_hunter_female",
  Artist: "yinyangshi", Aeromancer: "weather_artist", Wildsoul: "alchemist",
  "Guardian Knight": "dragon_knight",
};

function renderGateBadge(gate, state) {
  // 5-state legend:
  //   synced        green checkmark
  //   pending       yellow down-arrow (will write)
  //   mode-conflict orange exclamation (will mode-reset + write)
  //   db-other-mode blue dot (DB cleared at different mode, file silent)
  //   empty         gray dot
  const cls = `gate-badge gate-${state}`;
  const symbol = state === "synced" ? "✓"
    : state === "pending" ? "⏬"
    : state === "mode-conflict" ? "⚠"
    : state === "db-other-mode" ? "◐"
    : "·";
  return `<span class="${cls}" title="${escapeHtml(gate)}: ${escapeHtml(t("diff.state." + state))}">${escapeHtml(gate)} ${symbol}</span>`;
}

function renderDiffLegend(scope) {
  // 4-state legend (db-other-mode collapsed into empty since it was
  // user-confusing - char did Hard then saw Normal cards full of
  // db-other-mode badges asking "why is this here"). Off-mode DB
  // clears no longer surface as activity at the OTHER mode.
  const collectCounts = window.__artistCollectDiffStateCounts;
  const counts = typeof collectCounts === "function" ? collectCounts(scope) : {};
  const states = ["synced", "pending", "mode-conflict", "empty"].filter((s) => counts[s] > 0);
  if (states.length === 0) return "";
  const items = states.map((s) => `<span class="legend-item gate-${s}">${s === "synced" ? "✓" : s === "pending" ? "⏬" : s === "mode-conflict" ? "⚠" : "·"} ${escapeHtml(t("diff.state." + s))}</span>`).join("");
  return `<div class="diff-legend">${items}</div>`;
}

function formatCharCell(bucket) {
  const icon = bucket?.classIcon
    ? `<img class="class-icon" src="${escapeHtml(bucket.classIcon)}" alt="${escapeHtml(bucket.className || "Class")}" title="${escapeHtml(bucket.className || "")}" loading="lazy">`
    : "";
  return `<span class="char-cell">${icon}<span>${escapeHtml(bucket?.charName || "?")}</span></span>`;
}

function resolveEncounterSource({ previewCols, encounterCols }) {
  const previewBossCol = pickColumn(previewCols, ["current_boss", "current_boss_name"]);
  const previewTsCol = pickColumn(previewCols, ["fight_start", "last_combat_packet"]);
  if (previewBossCol && previewTsCol) {
    return {
      table: "encounter_preview",
      bossCol: previewBossCol,
      tsCol: previewTsCol,
      charCol: pickColumn(previewCols, ["local_player", "local_player_name"]),
      diffCol: pickColumn(previewCols, ["difficulty"]),
      clearedCol: pickColumn(previewCols, ["cleared"]),
      playersCol: pickColumn(previewCols, ["players"]),
    };
  }

  const encounterBossCol = pickColumn(encounterCols, ["current_boss_name", "current_boss"]);
  const encounterTsCol = pickColumn(encounterCols, ["last_combat_packet", "fight_start"]);
  if (encounterBossCol && encounterTsCol) {
    return {
      table: "encounter",
      bossCol: encounterBossCol,
      tsCol: encounterTsCol,
      charCol: pickColumn(encounterCols, ["local_player", "local_player_name"]),
      diffCol: pickColumn(encounterCols, ["difficulty"]),
      clearedCol: pickColumn(encounterCols, ["cleared"]),
      playersCol: pickColumn(encounterCols, ["players"]),
    };
  }

  return null;
}

function pickColumn(cols, names) {
  return names.find((name) => cols.has(name)) || null;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function formatSchemaPreview(tableName, cols) {
  if (!cols || cols.size === 0) return `<code>${escapeHtml(tableName)}</code>: not found`;
  const colPreview = [...cols].slice(0, 16).map(escapeHtml).join(", ");
  return `<code>${escapeHtml(tableName)}</code>: ${colPreview}${cols.size > 16 ? "..." : ""}`;
}

// PRAGMA-based column lister. Returns a Set of column names present on
// `tableName`. Used for schema detection so query SQL adapts to whatever
// LOA Logs version actually wrote the file.
async function listColumns(sqlite3, db, tableName) {
  const cols = new Set();
  try {
    await sqlite3.exec(db, `PRAGMA table_info(${tableName});`, (row, _columns) => {
      // PRAGMA table_info row layout: [cid, name, type, notnull, dflt_value, pk]
      const name = row[1];
      if (typeof name === "string") cols.add(name);
    });
  } catch (err) {
    console.error("[local-sync] PRAGMA table_info failed:", err);
  }
  return cols;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ----- 4. Sync POST -----

syncBtn.addEventListener("click", async () => {
  if (!window.__artistSyncToken) {
    syncOutput.hidden = false;
    syncOutput.innerHTML = `<span class="status-err">${t("sync.noTokenCached")}</span> ${t("sync.noTokenCachedHint")}`;
    return;
  }
  if (!Array.isArray(lastDeltas) || lastDeltas.length === 0) {
    syncOutput.hidden = false;
    syncOutput.innerHTML = t("sync.nothingToSync");
    return;
  }
  syncBtn.disabled = true;
  syncOutput.hidden = false;
  syncOutput.textContent = t("sync.sending", { n: lastDeltas.length });
  try {
    const resp = await fetch("/api/raid-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${window.__artistSyncToken}`,
      },
      body: JSON.stringify({ deltas: lastDeltas }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      syncOutput.innerHTML = `<span class="status-err">${t("sync.failed", { status: resp.status })}</span> ${escapeHtml(data?.error || "unknown error")}`;
      syncBtn.disabled = false;
      return;
    }
    const a = (data.applied || []).length;
    const s = (data.skipped || []).length;
    const u = (data.unmapped || []).length;
    const r = (data.rejected || []).length;
    // Server shrinks token TTL to ~60s on a real apply (a > 0). Mirror
    // that into authState so the countdown reflects reality immediately.
    if (data.newExpSec && authState && authState.kind === "ok") {
      authState.expSec = data.newExpSec;
      renderAuthStatus();
    }
    let html = `<span class="status-ok">${t("sync.complete")}</span> ${t("sync.summary", { a, s, u, r })}`;
    if (a > 0) {
      html += `<br><br><strong>${t("sync.appliedLabel")}</strong><ul>`;
      for (const x of data.applied) {
        const raidLabel = getRaidLabel(x.raidKey);
        const modeLabel = getModeLabel(x.modeKey);
        html += `<li>${escapeHtml(x.charName)} - ${escapeHtml(raidLabel)} ${escapeHtml(modeLabel)} ${x.gates.join(",")}</li>`;
      }
      html += `</ul>`;
    }
    if (r > 0) {
      html += `<br><strong>${t("sync.rejectedLabel")}</strong><ul>`;
      for (const x of data.rejected) html += `<li>${escapeHtml(x.charName)} - ${escapeHtml(x.reason)}${x.error ? ` (${escapeHtml(x.error)})` : ""}</li>`;
      html += `</ul>`;
    }
    if (u > 0) {
      html += `<br><span class="hint">${t("sync.unmappedHint")} ${data.unmapped.slice(0, 5).map((x) => escapeHtml(x.boss)).join(", ")}${u > 5 ? `, ${t("sync.unmappedMore", { n: u - 5 })}` : ""}</span>`;
    }
    syncOutput.innerHTML = html;
  } catch (err) {
    syncOutput.innerHTML = `<span class="status-err">${t("sync.networkError")}</span> ${escapeHtml(err.message || String(err))}`;
    syncBtn.disabled = false;
  }
});
