// Local Sync web companion - Phase 4.5 (streaming SQLite via wa-sqlite).
//
// Architecture choices:
//   - vanilla JS (no React/Next/Vite). The page does 5 things: parse
//     URL token, set active i18n language, FSA permission, sql.js query,
//     POST sync. Adding a framework would ship 100kB+ of runtime for
//     ~280 LOC of logic.
//   - wa-sqlite (asyncify build) loaded from jsdelivr. We use a custom
//     async VFS (web/js/sync/file-vfs.js) that streams from File.slice() so
//     multi-GB encounters.db files don't blow Chrome's ArrayBuffer cap
//     (sql.js, the previous library, required full-file load and broke
//     at 4 GB with NotReadableError).
//   - SQLite only fetches the B-tree pages it needs - tens of MB even
//     on a 4 GB DB. Schema-detection via PRAGMA table_info adapts the
//     query to whichever LOA Logs version wrote the file.
//   - Active locale comes from the JWT token payload (`lang` field
//     minted by the bot). web/js/core/i18n.js + web/js/core/locales.js power the
//     vi/jp/en string swap. data-i18n attributes in index.html drive
//     the static-text swap; dynamic UI strings call t() inline.

"use strict";

import {
  setActiveLang,
  applyDomTranslations,
  t,
} from "/sync/js/core/i18n.js";
import {
  bootstrapAuthSession,
  decodePayload,
} from "/sync/js/core/auth.js";
import {
  saveHandle as savePersistedHandle,
  clearHandle as clearPersistedHandle,
  tryRestoreForUser,
} from "/sync/js/sync/file-persistence.js";
import {
  startProfileAutoSync,
  syncProfileSnapshotOnce,
  stopProfileAutoSync,
} from "/sync/js/profile/profile-sync.js";
import { createProfileProcessLogRenderer } from "/sync/js/profile/profile-process-log.js";
import { escapeHtml } from "/sync/js/core/html.js";
import { formatBytes } from "/sync/js/core/format.js";
import {
  renderDiffPage,
  renderPreviewStats,
} from "/sync/js/sync/preview-renderer.js";
import {
  renderNoDeltaProfileStatsQueuedResult,
  renderSyncApplyResult,
  summarizeSyncResult,
} from "/sync/js/sync/sync-result-renderer.js";
import {
  formatSchemaPreview,
  listColumns,
  quoteIdent,
  resolveEncounterSource,
} from "/sync/js/sync/sqlite-schema.js";

const $ = (id) => document.getElementById(id);
const authStatus = $("auth-status");
const fileSection = $("file-section");
const syncModeSection = $("sync-mode-section");
const weeklyModeTab = $("weekly-mode-tab");
const profileModeTab = $("profile-mode-tab");
const syncModeLock = $("sync-mode-lock");
const previewSection = $("preview-section");
const dropZone = $("drop-zone");
const pickFileBtn = $("pick-file-btn");
const fileMeta = $("file-meta");
const previewOutput = $("preview-output");
const previewStats = $("preview-stats");
const syncSection = $("sync-section");
const syncBtn = $("sync-btn");
const syncOutput = $("sync-output");
const profileSection = $("profile-section");
const profileSyncOutput = $("profile-sync-output");
const profileProcessLog = createProfileProcessLogRenderer({
  container: profileSyncOutput,
  escapeHtml,
});

// Cache the last successful query result so the Sync button can POST it
// without re-running the SQL. Set on every loadAndPreview() success.
let lastDeltas = null;
let previewUtilsPromise = null;
let selectedLocalFile = null;
let lockedSyncMode = null;

function loadPreviewUtils() {
  if (!previewUtilsPromise) {
    previewUtilsPromise = import("/sync/js/sync/preview-utils.js").then(async (mod) => {
      await mod.loadCatalog();
      window.__artistGetClassIconForLabel = mod.getClassIconForLabel;
      return mod;
    }).catch((err) => {
      previewUtilsPromise = null;
      throw err;
    });
  }
  return previewUtilsPromise;
}

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

// Pre-sync stats panel. Server is single source of truth for gold rates
// + completion math; client just renders. Fired off after lastDeltas
// settles so the panel reflects what THIS sync would do, not stale data.
async function fetchPreviewSummary(deltas) {
  if (!window.__artistSyncToken) return null;
  try {
    const resp = await fetch("/api/local-sync/preview-summary", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${window.__artistSyncToken}`,
      },
      body: JSON.stringify({ deltas: Array.isArray(deltas) ? deltas : [] }),
    });
    if (!resp.ok) {
      console.warn("[local-sync] preview-summary failed:", resp.status);
      return null;
    }
    const data = await resp.json();
    return data?.ok ? data : null;
  } catch (err) {
    console.warn("[local-sync] preview-summary threw:", err?.message || err);
    return null;
  }
}

async function getRosterAccountsForProfile() {
  if (Array.isArray(window.__artistRosterAccounts)) {
    return window.__artistRosterAccounts;
  }
  if (!window.__artistSyncToken) return [];
  const resp = await fetch("/api/me/roster", {
    headers: { "Authorization": `Bearer ${window.__artistSyncToken}` },
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.ok) {
    throw new Error(data?.error || `roster fetch failed HTTP ${resp.status}`);
  }
  window.__artistRosterAccounts = Array.isArray(data.accounts) ? data.accounts : [];
  return window.__artistRosterAccounts;
}

function renderProfileSyncStatus(kind, message) {
  profileProcessLog.render(kind, message);
}

function renderWeeklyProfileSyncStatus(kind, message) {
  const el = document.getElementById("weekly-profile-sync-status");
  if (!el || !message) return;
  const cls = kind === "err" ? "status-err" : kind === "ok" ? "status-ok" : "hint";
  el.innerHTML = `<span class="${cls}">${escapeHtml(message)}</span>`;
}

async function syncProfileStatsAfterWeeklySync() {
  if (!selectedLocalFile) return Promise.resolve(null);
  const { currentWeeklyResetStartMs } = await loadPreviewUtils();
  return syncProfileSnapshotOnce({
    file: selectedLocalFile,
    getDiscordId: () => window.__artistDiscordId,
    getLocalToken: () => window.__artistSyncToken,
    getRosterAccounts: getRosterAccountsForProfile,
    renderStatus: renderWeeklyProfileSyncStatus,
    updateLocalTokenExpSec: (newExpSec) => authSession.updateExpSec(newExpSec),
    reason: "weekly",
    minFightStartMs: currentWeeklyResetStartMs(),
  });
}

function renderSyncModeTabs() {
  if (!syncModeSection || !weeklyModeTab || !profileModeTab) return;
  const weeklyActive = lockedSyncMode === "weekly";
  const profileActive = lockedSyncMode === "profile";
  weeklyModeTab.classList.toggle("is-active", weeklyActive);
  profileModeTab.classList.toggle("is-active", profileActive);
  weeklyModeTab.setAttribute("aria-selected", weeklyActive ? "true" : "false");
  profileModeTab.setAttribute("aria-selected", profileActive ? "true" : "false");
  weeklyModeTab.disabled = profileActive;
  profileModeTab.disabled = weeklyActive;
  if (syncModeLock) {
    if (!lockedSyncMode) {
      syncModeLock.hidden = true;
      syncModeLock.textContent = "";
    } else {
      syncModeLock.hidden = false;
      syncModeLock.textContent = t(weeklyActive ? "syncMode.lockedWeekly" : "syncMode.lockedProfile");
    }
  }
}

function clearWeeklySurface() {
  previewSection.hidden = true;
  previewOutput.innerHTML = "";
  renderPreviewStats(previewStats, null);
  syncSection.hidden = true;
  syncBtn.disabled = true;
  syncOutput.hidden = true;
  syncOutput.innerHTML = "";
  lastDeltas = null;
}

function clearProfileSurface() {
  stopProfileAutoSync();
  profileSection.hidden = true;
  renderProfileSyncStatus(null, "");
}

function resetSyncModeChoice({ keepFile = true } = {}) {
  lockedSyncMode = null;
  if (!keepFile) selectedLocalFile = null;
  clearWeeklySurface();
  clearProfileSurface();
  if (syncModeSection) syncModeSection.hidden = !selectedLocalFile;
  renderSyncModeTabs();
}

async function activateWeeklyMode() {
  if (!selectedLocalFile || lockedSyncMode === "profile") return;
  lockedSyncMode = "weekly";
  clearProfileSurface();
  renderSyncModeTabs();
  previewSection.hidden = false;
  syncSection.hidden = true;
  previewOutput.textContent = t("preview.loadingWasm");
  renderWeekRange();
  await loadAndPreview(selectedLocalFile);
}

function activateProfileMode() {
  if (!selectedLocalFile || lockedSyncMode === "weekly") return;
  lockedSyncMode = "profile";
  clearWeeklySurface();
  renderSyncModeTabs();
  profileSection.hidden = false;
  startProfileAutoSync({
    file: selectedLocalFile,
    getDiscordId: () => window.__artistDiscordId,
    getLocalToken: () => window.__artistSyncToken,
    getRosterAccounts: getRosterAccountsForProfile,
    renderStatus: renderProfileSyncStatus,
    updateLocalTokenExpSec: (newExpSec) => authSession.updateExpSec(newExpSec),
  });
}

// ----- 1. Token parsing + i18n bootstrap -----
//
// Token is decoded client-side (no fetch) since it carries Discord ID + lang
// + expiry signed by the bot's HMAC secret. The decode is presentational
// only (server re-verifies on every POST) so we just need the payload
// fields, not crypto-trust.

const params = new URLSearchParams(window.location.search);
const token = params.get("token");

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

const authSession = bootstrapAuthSession({
  token,
  payload,
  authStatus,
  fileSection,
  t,
  escapeHtml,
});

// ----- 2. FSA file pick / drop -----

async function loadFile(file, { handle = null } = {}) {
  selectedLocalFile = file;
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
  // Refresh week range in case the page was open across a Wed 17:00
  // VN reset boundary - boot-time render would be stale by then.
  renderWeekRange();
  resetSyncModeChoice();
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
  resetSyncModeChoice({ keepFile: false });
}

if (weeklyModeTab) {
  weeklyModeTab.addEventListener("click", () => {
    activateWeeklyMode().catch((err) => {
      console.error("[local-sync] weekly mode failed:", err);
      previewSection.hidden = false;
      previewOutput.innerHTML = `<span class="status-err">${t("preview.openFailed")}</span> ${escapeHtml(err.message || String(err))}`;
    });
  });
}

if (profileModeTab) {
  profileModeTab.addEventListener("click", activateProfileMode);
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
      import("/sync/js/sync/file-vfs.js"),
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
  const { currentWeeklyResetStartMs } = await loadPreviewUtils();
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
  // Cache rows + schema for post-sync refresh (refreshDiffAndStats reuses
  // these without re-parsing SQLite). The query is cheap on a warm DB
  // but skipping it avoids an unnecessary file-system roundtrip after
  // the user already committed.
  window.__artistRows = rows;
  window.__artistSchemaDebug = { table, bossCol, tsCol, charCol: charCol || "-" };
  await rebuildDiffFromRows({ rows, schemaDebug: window.__artistSchemaDebug });
}

// Pure-data half of the preview pipeline: takes already-parsed rows +
// fetches fresh roster + (re)builds the diff/lastDeltas/state buckets +
// renders. Extracted so post-sync can refresh the panel without the
// SQLite layer underneath. Both runPreviewQuery (initial) and the sync
// success path (post-apply) call this.
async function rebuildDiffFromRows({ rows, schemaDebug, keepSyncOutput = false }) {
  const {
    bucketize,
    findUnmappedBosses,
    getRaidGateForBoss,
    buildDiff,
    normalizeDifficulty,
    makeBucketKey,
    buildActionableBucketKeySet,
    collectDiffStateCounts,
  } = await loadPreviewUtils();
  const syncRows = rows.filter((r) => r[3] && getRaidGateForBoss(r[0]));
  const buckets = bucketize(rows);
  const unmappedBosses = findUnmappedBosses(rows);
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
  // Cache the roster snapshot so the sync result renderer can resolve
  // accountName / className / itemLevel for each applied char without
  // re-fetching. Refreshed on every rebuildDiffFromRows call.
  window.__artistRosterAccounts = rosterAccounts;
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
    schemaDebug,
  };
  if (window.__artistViewMode !== "raid" && window.__artistViewMode !== "char") {
    window.__artistViewMode = "char";
  }
  renderDiffPage(previewOutput);
  syncSection.hidden = false;
  syncBtn.disabled = lastDeltas.length === 0 && !((window.__artistRows || []).length > 0);
  // Post-sync callers pass keepSyncOutput so the success summary they
  // just rendered stays visible. Initial preview wipes it to either
  // "nothing to sync" hint or hidden depending on actionable count.
  if (!keepSyncOutput) {
    if (lastDeltas.length === 0) {
      syncOutput.hidden = false;
      syncOutput.innerHTML = t("sync.nothingToSyncFull");
    } else {
      syncOutput.hidden = true;
    }
  }
  // Stats panel fetch is async + non-blocking. Refreshed on every
  // rebuildDiffFromRows call so post-sync state reflects new gold/%/
  // pending immediately.
  fetchPreviewSummary(lastDeltas)
    .then((summary) => renderPreviewStats(previewStats, summary))
    .catch(() => {});
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
    if (!((window.__artistRows || []).length > 0)) {
      syncOutput.innerHTML = t("sync.nothingToSync");
      return;
    }
    syncBtn.disabled = true;
    syncOutput.innerHTML = renderNoDeltaProfileStatsQueuedResult();
    try {
      await syncProfileStatsAfterWeeklySync();
    } catch (err) {
      renderWeeklyProfileSyncStatus("err", err?.message || String(err));
    } finally {
      syncBtn.disabled = false;
    }
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
    const { applied: a } = summarizeSyncResult(data);
    // Server shrinks token TTL to ~60s on a real apply (a > 0). Mirror
    // that into the auth pill so the countdown reflects reality immediately.
    authSession.updateExpSec(data.newExpSec);
    syncOutput.innerHTML = renderSyncApplyResult(data, window.__artistRosterAccounts || []);
    syncOutput.hidden = false;
    const profileStatsPromise = syncProfileStatsAfterWeeklySync();

    // Refresh section 3 (preview cards + stats panel) after a real apply
    // so the user sees post-sync state immediately - synced gates flip
    // from pending to synced, gold drops, completion % climbs. Pass
    // keepSyncOutput so we don't clobber the success summary above.
    if (a > 0 && window.__artistRows) {
      rebuildDiffFromRows({
        rows: window.__artistRows,
        schemaDebug: window.__artistSchemaDebug,
        keepSyncOutput: true,
      }).catch((err) => {
        console.warn("[local-sync] post-sync refresh failed:", err?.message || err);
      });
    }
    await profileStatsPromise;
  } catch (err) {
    syncOutput.innerHTML = `<span class="status-err">${t("sync.networkError")}</span> ${escapeHtml(err.message || String(err))}`;
    syncBtn.disabled = false;
  }
});
