// Local Reader - streaming SQLite via wa-sqlite, Discord confirmation handoff.
//
// Architecture choices:
//   - vanilla JS (no React/Next/Vite). The page parses the signed URL,
//     restores FSA permission, watches encounters.db revisions, queries
//     SQLite, builds a roster diff, then POSTs a confirmation preview.
//     The state machine is explicit, so a UI framework would add runtime
//     weight without improving the file/query correctness boundary.
//   - wa-sqlite (asyncify build) served from this deployment. A custom
//     async VFS (web/js/sync/file/file-vfs.js) that streams from File.slice() so
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
  readAndScrubLocalSyncToken,
  resolveCompanionScope,
} from "/sync/js/core/auth.js";
import {
  saveHandle as savePersistedHandle,
  clearHandle as clearPersistedHandle,
  tryRestoreForUser,
} from "/sync/js/sync/file/file-persistence.js";
import { escapeHtml } from "/sync/js/core/html.js";
import { formatBytes } from "/sync/js/core/format.js";
import {
  renderDiffPage,
  renderPreviewStats,
} from "/sync/js/sync/render/preview-renderer.js";
import {
  formatSchemaPreview,
  listColumns,
  quoteIdent,
  resolveEncounterSource,
} from "/sync/js/sync/sqlite-schema.js";
import {
  buildEncounterPreviewSql,
  filterRowsForSyncScope,
} from "/sync/js/sync/encounter-query.js";
import {
  createFileChangeMonitor,
  createLatestOnlyRunner,
  readFileHandleSnapshot,
  readFileRevision,
  readStableFileHandleSnapshot,
  sameFileRevision,
} from "/sync/js/sync/file/file-change-monitor.js";

const $ = (id) => document.getElementById(id);
const authStatus = $("auth-status");
const fileSection = $("file-section");
const previewSection = $("preview-section");
const dropZone = $("drop-zone");
const pickFileBtn = $("pick-file-btn");
const fileMeta = $("file-meta");
const fileLiveStatus = $("file-live-status");
const previewOutput = $("preview-output");
const previewStats = $("preview-stats");
const syncSection = $("sync-section");
const syncBtn = $("sync-btn");
const syncOutput = $("sync-output");

// Cache only the last atomically committed query result so the Discord-preview
// button can POST it without accepting data from a superseded refresh.
let lastDeltas = null;
let lastPartyDeltas = null;
let previewUtilsPromise = null;
let selectedLocalFile = null;
let selectedFileHandle = null;
let selectedFileRevision = null;
let lastRenderedRevision = null;
let fileChangeMonitor = null;
let selectionSerial = 0;
let sqliteRuntimePromise = null;
let previewSummaryController = null;
let previewRetryTimer = null;
let previewRetryAttempts = 0;
const PRE_SEND_CHANGE_SETTLE_MS = 80;

function makeAbortError(message = "preview superseded") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfPreviewSuperseded(context, expectedSelection = selectionSerial) {
  if (context?.signal?.aborted
      || (typeof context?.isCurrent === "function" && !context.isCurrent())
      || expectedSelection !== selectionSerial) {
    throw makeAbortError();
  }
}

function setFileLiveStatus(state, key, vars = {}) {
  if (!fileLiveStatus) return;
  fileLiveStatus.hidden = false;
  fileLiveStatus.dataset.state = state;
  fileLiveStatus.textContent = t(key, vars);
}

function hideFileLiveStatus() {
  if (!fileLiveStatus) return;
  fileLiveStatus.hidden = true;
  fileLiveStatus.textContent = "";
  delete fileLiveStatus.dataset.state;
}

function stopFileMonitoring() {
  fileChangeMonitor?.stop();
  fileChangeMonitor = null;
}

function clearPreviewRetry({ resetAttempts = true } = {}) {
  if (previewRetryTimer != null) clearTimeout(previewRetryTimer);
  previewRetryTimer = null;
  if (resetAttempts) previewRetryAttempts = 0;
}

function schedulePreviewRetry(expectedSelection = selectionSerial) {
  if (previewRetryTimer != null || !selectedFileHandle) return;
  const delay = Math.min(30_000, 1_250 * (2 ** Math.min(previewRetryAttempts, 5)));
  previewRetryAttempts += 1;
  previewRetryTimer = setTimeout(async () => {
    previewRetryTimer = null;
    if (expectedSelection !== selectionSerial || !selectedFileHandle) return;
    try {
      const snapshot = await readStableFileHandleSnapshot(selectedFileHandle, {
        settleMs: 200,
        maxAttempts: 4,
      });
      if (!snapshot) {
        schedulePreviewRetry(expectedSelection);
        return;
      }
      selectedLocalFile = snapshot.file;
      selectedFileRevision = snapshot.revision;
      void queuePreviewRefresh(snapshot, {
        reason: "retry",
        expectedSelection,
      });
    } catch (error) {
      console.warn("[local-sync] realtime retry failed:", error?.message || error);
      schedulePreviewRetry(expectedSelection);
    }
  }, delay);
}

function renderSelectedFileMeta(file) {
  if (!file) return;
  fileMeta.hidden = false;
  fileMeta.innerHTML = `<div class="file-meta-row"><span>${t("file.selected")} <strong>${escapeHtml(file.name)}</strong> · ${formatBytes(file.size)} · ${t("file.modified")} ${new Date(file.lastModified).toLocaleString()}</span><button id="remove-file-btn" type="button" class="remove-file-btn">${escapeHtml(t("file.removeBtn"))}</button></div>`;
  document.getElementById("remove-file-btn")?.addEventListener("click", handleRemoveFile);
}

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

const previewRefreshRunner = createLatestOnlyRunner(runPreviewRefresh);

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
async function fetchPreviewSummary(deltas, { signal } = {}) {
  if (!window.__artistSyncToken) return null;
  try {
    const resp = await fetch("/api/local-sync/preview-summary", {
      method: "POST",
      signal,
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
    if (err?.name === "AbortError") return null;
    console.warn("[local-sync] preview-summary threw:", err?.message || err);
    return null;
  }
}

function clearArtistPreviewGlobals() {
  window.__artistRows = [];
  window.__artistSchemaDebug = null;
  window.__artistRosterAccounts = [];
  window.__artistDiff = [];
  window.__artistCollectDiffStateCounts = null;
  window.__artistUnmappedBosses = [];
  window.__artistRosterError = "";
  window.__artistMeta = null;
}

function clearSyncSurface() {
  previewSummaryController?.abort();
  previewSummaryController = null;
  previewSection.hidden = true;
  previewOutput.innerHTML = "";
  renderPreviewStats(previewStats, null);
  syncSection.hidden = true;
  syncBtn.disabled = true;
  syncOutput.hidden = true;
  syncOutput.innerHTML = "";
  lastDeltas = null;
  lastPartyDeltas = null;
  lastRenderedRevision = null;
  clearArtistPreviewGlobals();
}

function resetSyncSurface({ keepFile = true } = {}) {
  clearPreviewRetry();
  previewRefreshRunner.invalidate();
  if (!keepFile) {
    selectedLocalFile = null;
    selectedFileHandle = null;
    selectedFileRevision = null;
  }
  clearSyncSurface();
}

function queuePreviewRefresh(snapshot, {
  reason = "manual",
  showLoading = false,
  expectedSelection = selectionSerial,
  scheduleOnFailure = true,
} = {}) {
  if (!snapshot?.file || !snapshot?.revision) return Promise.resolve(null);
  if (reason !== "retry") clearPreviewRetry();
  previewSection.hidden = false;
  renderWeekRange();
  const promise = previewRefreshRunner.request({
    ...snapshot,
    handle: selectedFileHandle,
    reason,
    showLoading,
    expectedSelection,
  });
  promise.catch((error) => {
    if (error?.name === "AbortError" || expectedSelection !== selectionSerial) return;
    console.error("[local-sync] realtime refresh failed:", error);
    syncBtn.disabled = true;
    setFileLiveStatus("error", "file.liveRetrying");
    previewOutput.innerHTML = error.userHtml
      || `<span class="status-err">${t("preview.openFailed")}</span> ${escapeHtml(error.message || String(error))}<br><span class="hint">${t("preview.openFailedHint")}</span>`;
    if (scheduleOnFailure) schedulePreviewRetry(expectedSelection);
  });
  return promise;
}

async function activateSyncPreview(file, { revision = null } = {}) {
  if (!file) return;
  const nextRevision = revision || await readFileRevision(file);
  return queuePreviewRefresh({ file, revision: nextRevision }, {
    reason: "initial",
    showLoading: true,
    expectedSelection: selectionSerial,
  });
}

// ----- 1. Token parsing + i18n bootstrap -----
//
// Token is decoded client-side (no fetch) since it carries Discord ID + lang
// + expiry signed by the bot's HMAC secret. The decode is presentational
// only because the server re-verifies every POST; only the payload fields are
// needed on the client.

// New links keep the bearer token in the URL fragment, which browsers never
// send to Railway/proxy access logs or Referer headers. Query parsing remains
// as a migration fallback for previously issued short-lived links.
const token = readAndScrubLocalSyncToken(window);

const payload = token ? decodePayload(token) : null;
const syncScope = resolveCompanionScope(payload);

// Resolve the active language BEFORE rendering anything user-facing.
// Token's `lang` field is the bot-side getUserLanguage(discordId) result
// at mint time. Falls back to vi (User.language schema default) when:
//   - no token present (page opened without /raid-auto-manage local-on)
//   - token is malformed (bad payload)
//   - token doesn't carry lang (legacy mint before Phase i18n)
window.__artistSyncScope = syncScope;
setActiveLang(payload?.lang || "vi");
applyDomTranslations();
renderWeekRange();

// Static <html lang> + <body dir> attributes follow the active locale so
// fonts + line-breaking heuristics match. JP/Chinese-derived glyphs in
// particular benefit from the right `lang` hint for browser font fallback.
document.documentElement.setAttribute("lang", window.__artistLang || "vi");

bootstrapAuthSession({
  token,
  payload,
  authStatus,
  fileSection,
  t,
  escapeHtml,
});

// ----- 2. FSA file pick / drop -----

async function loadFile(file, { handle = null } = {}) {
  stopFileMonitoring();
  selectionSerial += 1;
  const expectedSelection = selectionSerial;
  resetSyncSurface({ keepFile: false });
  fileMeta.hidden = true;
  fileMeta.innerHTML = "";
  hideFileLiveStatus();
  const revision = await readFileRevision(file);
  // Auto-restore and a user-initiated picker can overlap during page startup.
  // Whichever selection started last owns the UI; an older getFile()/header
  // read must never come back later and replace it.
  if (expectedSelection !== selectionSerial) return;
  selectedLocalFile = file;
  selectedFileHandle = handle;
  selectedFileRevision = revision;
  renderSelectedFileMeta(file);
  // Refresh week range in case the page was open across a Wed 17:00
  // VN reset boundary - boot-time render would be stale by then.
  renderWeekRange();
  if (handle) {
    setFileLiveStatus("updating", "file.liveStarting");
    fileChangeMonitor = createFileChangeMonitor({
      handle,
      onChange: (snapshot) => {
        if (expectedSelection !== selectionSerial || handle !== selectedFileHandle) {
          return null;
        }
        selectedLocalFile = snapshot.file;
        selectedFileRevision = snapshot.revision;
        return queuePreviewRefresh(snapshot, {
          reason: "file-change",
          expectedSelection,
          scheduleOnFailure: false,
        });
      },
      onStatus: ({ type }) => {
        if (expectedSelection !== selectionSerial) return;
        if (type === "detected" || type === "stable") {
          syncBtn.disabled = true;
          setFileLiveStatus("updating", "file.liveUpdating");
        } else if (type === "error") {
          syncBtn.disabled = true;
          setFileLiveStatus("error", "file.liveRetrying");
        }
      },
    });
    fileChangeMonitor.start({ baselineRevision: selectedFileRevision });
  } else {
    setFileLiveStatus("static", "file.liveStatic");
  }
  await activateSyncPreview(file, { revision: selectedFileRevision }).catch(() => {
    // queuePreviewRefresh already rendered the detailed failure. Keep the
    // selected handle alive so the monitor can retry after the file settles.
  });
  if (expectedSelection !== selectionSerial || handle !== selectedFileHandle) return;
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
  stopFileMonitoring();
  selectionSerial += 1;
  try {
    await clearPersistedHandle();
  } catch (err) {
    console.warn("[local-sync] clearHandle failed:", err?.message || err);
  }
  // Reset UI back to the dropzone state. previewOutput + sync section
  // hide so user knows nothing's loaded.
  fileMeta.hidden = true;
  fileMeta.innerHTML = "";
  hideFileLiveStatus();
  resetSyncSurface({ keepFile: false });
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
// this seamless when granted; otherwise the UI surfaces a Restore button
// that the user clicks to elevate permission inside a user gesture.
async function attemptRestoreFromIdb() {
  if (!window.__artistDiscordId) return;
  const expectedRestoreSelection = selectionSerial;
  let restore;
  try {
    restore = await tryRestoreForUser(window.__artistDiscordId);
  } catch (err) {
    console.warn("[local-sync] restore lookup failed:", err?.message || err);
    return;
  }
  // A manual pick/remove that happened while IndexedDB was opening always
  // outranks the automatic restore started at page boot.
  if (expectedRestoreSelection !== selectionSerial || selectedLocalFile) return;
  if (!restore) return;
  if (restore.granted) {
    // Permission still valid - load file immediately.
    try {
      const file = await restore.handle.getFile();
      if (expectedRestoreSelection !== selectionSerial || selectedLocalFile) return;
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

window.addEventListener("beforeunload", () => {
  stopFileMonitoring();
  clearPreviewRetry();
  previewRefreshRunner.invalidate();
  previewSummaryController?.abort();
});

// ----- 3. wa-sqlite query (streaming VFS) -----
//
// Replaces the previous sql.js full-file load. wa-sqlite + FileBackedVFS
// only reads the SQLite B-tree pages touched by the query (~tens
// of MB on a 4 GB DB), so file size is no longer a wall. Trade-off: more
// async coordination + asyncify-built WASM is ~700 KB vs sql.js 1.5 MB,
// roughly even.

const WA_SQLITE_BASE = "/sync/vendor/wa-sqlite";

async function loadSqliteRuntime() {
  if (!sqliteRuntimePromise) {
    sqliteRuntimePromise = (async () => {
      // Imports and WASM compilation are cached once for the entire tab.
      // Realtime refreshes only swap the File snapshot inside the same VFS.
      const [SQLiteESMFactoryModule, SQLiteAPI, FileVfsModule] = await Promise.all([
        import(`${WA_SQLITE_BASE}/dist/wa-sqlite-async.mjs`),
        import(`${WA_SQLITE_BASE}/src/sqlite-api.js`),
        import("/sync/js/sync/file/file-vfs.js"),
      ]);
      const module = await SQLiteESMFactoryModule.default();
      const sqlite3 = SQLiteAPI.Factory(module);
      const vfs = await FileVfsModule.FileBackedVFS.create("file-vfs", module);
      sqlite3.vfs_register(vfs, false);
      return { sqlite3, SQLiteAPI, vfs };
    })().catch((error) => {
      sqliteRuntimePromise = null;
      throw error;
    });
  }
  return sqliteRuntimePromise;
}

async function queryPreviewFile(file, context, expectedSelection) {
  const { sqlite3, SQLiteAPI, vfs } = await loadSqliteRuntime();
  throwIfPreviewSuperseded(context, expectedSelection);
  vfs.setFile("encounters.db", file);
  let db = null;
  try {
    db = await sqlite3.open_v2(
      "encounters.db",
      SQLiteAPI.SQLITE_OPEN_READONLY,
      "file-vfs"
    );
    return await runPreviewQuery(sqlite3, db, context, expectedSelection);
  } finally {
    if (db != null) await sqlite3.close(db);
    else await vfs.close();
  }
}

// Query the current LOA Logs preview table first. Recent LOA Logs versions
// moved boss/char/difficulty/clear metadata from `encounter` into
// `encounter_preview`; `encounter` now stores mostly raw damage totals.
// Fall back to the older single-table shape for legacy DBs.
async function runPreviewQuery(sqlite3, db, context, expectedSelection) {
  const previewCols = await listColumns(sqlite3, db, "encounter_preview");
  const encounterCols = await listColumns(sqlite3, db, "encounter");
  throwIfPreviewSuperseded(context, expectedSelection);
  if (previewCols.size === 0 && encounterCols.size === 0) {
    return {
      kind: "message",
      html: `<span class="status-err">${t("preview.noTable")}</span> ${t("preview.noTableHint")}`,
    };
  }
  const source = resolveEncounterSource({ previewCols, encounterCols });
  if (!source) {
    return {
      kind: "message",
      html: `<span class="status-err">${t("preview.missingCols")}</span><br>${formatSchemaPreview("encounter_preview", previewCols)}<br>${formatSchemaPreview("encounter", encounterCols)}<br><span class="hint">${t("preview.missingColsHint")}</span>`,
    };
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
  throwIfPreviewSuperseded(context, expectedSelection);
  const currentWeekStartMs = currentWeeklyResetStartMs();
  if (syncScope === "solo" && !diffSql) {
    return {
      kind: "message",
      html: `<span class="status-err">${t("preview.soloDifficultyMissing")}</span><br><span class="hint">${t("preview.soloDifficultyMissingHint")}</span>`,
    };
  }
  const sql = buildEncounterPreviewSql({
    tableSql,
    bossSql,
    tsSql,
    diffSql,
    clearedSql,
    charSql,
    playersSql,
    scope: syncScope,
  });
  const rows = [];
  try {
    await sqlite3.exec(db, sql.replace("?", String(currentWeekStartMs)), (row) => {
      rows.push(row);
    });
  } catch (err) {
    err.userHtml = `<span class="status-err">${t("preview.queryFailed")}</span> ${escapeHtml(err.message || String(err))}<br><span class="hint">Table: <code>${escapeHtml(table)}</code>, boss column: <code>${escapeHtml(bossCol)}</code>, ts column: <code>${escapeHtml(tsCol)}</code>. ${t("preview.queryFailedHint")}</span>`;
    throw err;
  }
  throwIfPreviewSuperseded(context, expectedSelection);
  const scopedRows = filterRowsForSyncScope(rows, syncScope);
  if (scopedRows.length === 0) {
    // Both values are repo-owned locale strings, not file or user input,
    // and carry intentional <strong> markup like preview.headlineCount does.
    return {
      kind: "message",
      html: `<div class="empty-state"><p class="empty-state-title">${t("preview.noRecent")}</p><p class="empty-state-hint">${t("preview.nothingToSync")}</p></div>`,
    };
  }
  return {
    kind: "rows",
    rows: scopedRows,
    schemaDebug: { table, bossCol, tsCol, charCol: charCol || "-" },
  };
}

// Pure-data half of the preview pipeline. It deliberately returns a state
// object instead of mutating the DOM: only runPreviewRefresh may commit, after
// one final file-revision check proves the SQLite snapshot is still current.
async function fetchRosterSnapshot(context) {
  let rosterAccounts = [];
  let rosterError = "";
  try {
    const resp = await fetch("/api/me/roster", {
      signal: context?.signal,
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
    if (err?.name === "AbortError") throw err;
    rosterError = err?.message || String(err);
    console.warn("[local-sync] roster fetch threw:", err?.message || err);
  }
  return { rosterAccounts, rosterError };
}

async function buildPreviewStateFromRows(
  { rows, schemaDebug },
  context,
  expectedSelection,
  { previewUtilsReady = null, rosterSnapshotReady = null } = {}
) {
  // Both promises are started before SQLite opens. Awaiting them here overlaps
  // catalog/roster I/O with WASM setup and the weekly encounter scan.
  const utilsPromise = previewUtilsReady || loadPreviewUtils();
  const rosterPromise = rosterSnapshotReady || fetchRosterSnapshot(context);
  const {
    bucketize,
    expandPartyEncounterRows,
    findUnmappedBosses,
    getRaidGateForBoss,
    buildDiff,
    normalizeDifficulty,
    makeBucketKey,
    buildActionableBucketKeySet,
    collectDiffStateCounts,
    currentWeeklyResetStartMs,
  } = await utilsPromise;
  throwIfPreviewSuperseded(context, expectedSelection);
  const scopedRows = filterRowsForSyncScope(rows, syncScope);
  const syncRows = scopedRows.filter((r) => (
    Number(r[2]) === 1 && r[3] && getRaidGateForBoss(r[0])
  ));
  const buckets = bucketize(scopedRows);
  const unmappedBosses = findUnmappedBosses(scopedRows);
  const { rosterAccounts, rosterError } = await rosterPromise;
  throwIfPreviewSuperseded(context, expectedSelection);
  const diff = buildDiff(rosterAccounts, buckets, {
    allowedModeKeys: syncScope === "solo" ? ["solo"] : null,
    currentWeekStartMs: currentWeeklyResetStartMs(),
  });
  const actionableKeys = buildActionableBucketKeySet(diff, {
    // Full Local Sync keeps its intentional mode-switch behavior. The
    // Auto-sync companion never submits a Solo clear that would replace
    // positive progress already stored under another difficulty.
    includeModeConflict: syncScope !== "solo",
  });
  const actionableSourceRows = syncRows.filter((r) => {
    const gateInfo = getRaidGateForBoss(r[0]);
    const modeKey = normalizeDifficulty(r[1]);
    if (!modeKey) return false;
    return actionableKeys.has(makeBucketKey(r[3], gateInfo.raidKey, modeKey));
  });
  const deltas = actionableSourceRows
    .map((r) => ({
      boss: r[0],
      difficulty: r[1],
      cleared: 1,
      charName: r[3],
      lastClearMs: Number(r[5]) || 0,
    }));
  const syncableBuckets = buckets.filter((b) => actionableKeys.has(makeBucketKey(b.charName, b.raidKey, b.modeKey)));
  // Expand only source encounters that this exact preview can apply. Besides
  // reducing the handoff payload, this keeps every propagated participant
  // structurally tied to a source delta stored in the same preview job.
  const partyBuckets = syncScope === "full"
    ? bucketize(expandPartyEncounterRows(actionableSourceRows))
    : [];
  const partyDeltas = partyBuckets
    .filter((bucket) => (
      String(bucket.charName || "").trim().toLowerCase()
      !== String(bucket.sourceCharName || "").trim().toLowerCase()
    ))
    .map((bucket) => ({
      boss: bucket.boss,
      difficulty: bucket.difficulty,
      cleared: 1,
      charName: bucket.charName,
      sourceCharName: bucket.sourceCharName,
      lastClearMs: bucket.lastClearMs,
    }));
  return {
    rows: scopedRows,
    schemaDebug,
    rosterAccounts,
    rosterError,
    diff,
    deltas,
    partyDeltas,
    unmappedBosses,
    collectDiffStateCounts,
    meta: {
      distinctChars: new Set(syncableBuckets.map((b) => String(b.charName || "").trim().toLowerCase())).size,
      clears: syncableBuckets.length,
      detectedChars: new Set(buckets.map((b) => String(b.charName || "").trim().toLowerCase())).size,
      detectedClears: buckets.length,
      schemaDebug,
    },
  };
}

function clearCommittedPreviewState() {
  lastDeltas = [];
  lastPartyDeltas = [];
  clearArtistPreviewGlobals();
  renderPreviewStats(previewStats, null);
  syncSection.hidden = true;
  syncBtn.disabled = true;
  syncOutput.hidden = true;
  syncOutput.innerHTML = "";
}

function commitMessagePreview(result) {
  clearCommittedPreviewState();
  previewOutput.innerHTML = result.html;
}

function commitPreviewState(state, { revision, expectedSelection }) {
  // Cache the roster snapshot so result renderers can resolve account/class
  // metadata without another request. Every assignment belongs to this one
  // atomic commit block, after freshness has been proven.
  lastDeltas = state.deltas;
  lastPartyDeltas = state.partyDeltas;
  window.__artistRows = state.rows;
  window.__artistSchemaDebug = state.schemaDebug;
  window.__artistRosterAccounts = state.rosterAccounts;
  window.__artistDiff = state.diff;
  if (!Number.isFinite(Number(window.__artistRosterPage))) window.__artistRosterPage = 0;
  window.__artistUnmappedBosses = state.unmappedBosses;
  window.__artistRosterError = state.rosterError;
  window.__artistCollectDiffStateCounts = state.collectDiffStateCounts;
  window.__artistMeta = state.meta;
  if (window.__artistViewMode !== "raid" && window.__artistViewMode !== "char") {
    window.__artistViewMode = "char";
  }
  renderDiffPage(previewOutput);
  syncSection.hidden = false;
  syncBtn.disabled = lastDeltas.length === 0 || revision.writeVersion === 2;
  if (lastDeltas.length === 0) {
    syncOutput.hidden = false;
    syncOutput.innerHTML = t("sync.nothingToSyncFull");
  } else {
    syncOutput.hidden = true;
    syncOutput.innerHTML = "";
  }
  renderPreviewStats(previewStats, null);
  previewSummaryController?.abort();
  const controller = new AbortController();
  previewSummaryController = controller;
  fetchPreviewSummary(lastDeltas, { signal: controller.signal })
    .then((summary) => {
      if (!controller.signal.aborted
          && expectedSelection === selectionSerial
          && sameFileRevision(lastRenderedRevision, revision)) {
        renderPreviewStats(previewStats, summary);
      }
    })
    .catch(() => {})
    .finally(() => {
      if (previewSummaryController === controller) previewSummaryController = null;
    });
}

async function runPreviewRefresh(request, context) {
  const {
    file,
    revision,
    handle,
    showLoading,
    expectedSelection,
  } = request;
  throwIfPreviewSuperseded(context, expectedSelection);
  previewSummaryController?.abort();
  previewSummaryController = null;
  syncBtn.disabled = true;
  setFileLiveStatus("updating", request.reason === "pre-send"
    ? "file.liveVerifying"
    : "file.liveUpdating");
  if (showLoading) {
    syncSection.hidden = true;
    previewOutput.textContent = t("preview.loadingWasm");
  }

  const previewUtilsReady = loadPreviewUtils();
  const rosterSnapshotReady = fetchRosterSnapshot(context);
  // A malformed/empty SQLite file can finish before either warmup is consumed.
  // Attach observers immediately so those intentionally abandoned promises can
  // never surface as unhandled rejections.
  void previewUtilsReady.catch(() => {});
  void rosterSnapshotReady.catch(() => {});
  const queryResult = await queryPreviewFile(file, context, expectedSelection);
  throwIfPreviewSuperseded(context, expectedSelection);
  const previewState = queryResult.kind === "rows"
    ? await buildPreviewStateFromRows(queryResult, context, expectedSelection, {
        previewUtilsReady,
        rosterSnapshotReady,
      })
    : null;
  throwIfPreviewSuperseded(context, expectedSelection);

  // File objects are immutable snapshots. Re-open the handle after all async
  // SQLite/network work; if LOA Logs committed meanwhile, discard everything
  // above and queue only the newest on-disk state.
  if (handle && handle === selectedFileHandle) {
    const latest = await readFileHandleSnapshot(handle);
    throwIfPreviewSuperseded(context, expectedSelection);
    if (!sameFileRevision(revision, latest.revision)) {
      selectedLocalFile = latest.file;
      selectedFileRevision = latest.revision;
      void queuePreviewRefresh(latest, {
        reason: "post-query-change",
        expectedSelection,
        scheduleOnFailure: false,
      });
      throw makeAbortError("file changed while preview was building");
    }
  }

  throwIfPreviewSuperseded(context, expectedSelection);
  lastRenderedRevision = revision;
  selectedLocalFile = file;
  selectedFileRevision = revision;
  renderSelectedFileMeta(file);
  if (previewState) commitPreviewState(previewState, { revision, expectedSelection });
  else commitMessagePreview(queryResult);
  fileChangeMonitor?.setBaseline(revision);

  if (previewState?.rosterError) {
    syncBtn.disabled = true;
    setFileLiveStatus("error", "file.liveRetrying");
    schedulePreviewRetry(expectedSelection);
  } else if (!handle) {
    clearPreviewRetry();
    setFileLiveStatus("static", "file.liveStatic");
  } else if (revision.writeVersion === 2) {
    clearPreviewRetry();
    syncBtn.disabled = true;
    setFileLiveStatus("warning", "file.liveWalWarning");
  } else {
    clearPreviewRetry();
    setFileLiveStatus("ready", "file.liveReady", {
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    });
  }
  return { revision, actionable: lastDeltas.length };
}

// ----- 4. Discord preview handoff -----

async function ensureFreshPreviewBeforeSend(maxAttempts = 4) {
  if (!selectedFileHandle) return true;
  const expectedHandle = selectedFileHandle;
  const expectedSelection = selectionSerial;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await previewRefreshRunner.whenIdle();
    if (expectedHandle !== selectedFileHandle || expectedSelection !== selectionSerial) {
      return false;
    }
    // Fast path: a fresh 100-byte header probe proves that the immutable file
    // snapshot rendered on screen is still the one on disk. The preview-job
    // endpoint re-projects against the current roster, so an unchanged file
    // does not need another SQLite scan or roster round trip on every click.
    const latest = await readFileHandleSnapshot(expectedHandle);
    selectedLocalFile = latest.file;
    selectedFileRevision = latest.revision;
    if (sameFileRevision(lastRenderedRevision, latest.revision)) {
      return true;
    }

    // Only a changed file pays the stability window. Reuse the probe above to
    // avoid another getFile(), then rebuild the newest settled revision.
    const stable = await readStableFileHandleSnapshot(expectedHandle, {
      settleMs: PRE_SEND_CHANGE_SETTLE_MS,
      maxAttempts: 4,
      initialSnapshot: latest,
    });
    if (!stable) return false;
    selectedLocalFile = stable.file;
    selectedFileRevision = stable.revision;
    const outcome = await queuePreviewRefresh(stable, {
      reason: "pre-send",
      expectedSelection,
    });
    if (outcome?.status === "completed"
        && sameFileRevision(lastRenderedRevision, stable.revision)) {
      // Close the post-query window with one immediate header read. A commit
      // after this read belongs to the next user action; a commit before it is
      // detected and sent through another latest-only iteration.
      const finalSnapshot = await readFileHandleSnapshot(expectedHandle);
      if (expectedHandle !== selectedFileHandle || expectedSelection !== selectionSerial) {
        return false;
      }
      selectedLocalFile = finalSnapshot.file;
      selectedFileRevision = finalSnapshot.revision;
      if (sameFileRevision(lastRenderedRevision, finalSnapshot.revision)) {
        return true;
      }
    }
  }
  return false;
}

function canSendCurrentPreview() {
  return Array.isArray(lastDeltas)
    && lastDeltas.length > 0
    && sameFileRevision(lastRenderedRevision, selectedFileRevision)
    && lastRenderedRevision?.writeVersion !== 2
    && previewRefreshRunner.isIdle();
}

syncBtn.addEventListener("click", async () => {
  if (!window.__artistSyncToken) {
    syncOutput.hidden = false;
    syncOutput.innerHTML = `<span class="status-err">${t("sync.noTokenCached")}</span> ${t("sync.noTokenCachedHint")}`;
    return;
  }
  syncBtn.disabled = true;
  syncOutput.hidden = false;
  syncOutput.textContent = t("sync.verifyingFreshness");
  try {
    const fresh = await ensureFreshPreviewBeforeSend();
    if (!fresh) {
      syncOutput.innerHTML = `<span class="status-warn">${escapeHtml(t("sync.fileBusy"))}</span>`;
      return;
    }
    if (lastRenderedRevision?.writeVersion === 2) {
      syncOutput.innerHTML = `<span class="status-warn">${escapeHtml(t("sync.walUnsafe"))}</span>`;
      return;
    }
    if (!Array.isArray(lastDeltas) || lastDeltas.length === 0) {
      syncOutput.innerHTML = t((window.__artistRows || []).length > 0 ? "sync.nothingToSyncFull" : "sync.nothingToSync");
      return;
    }
    const deltasToSend = lastDeltas.map((delta) => ({ ...delta }));
    const partyDeltasToSend = Array.isArray(lastPartyDeltas)
      ? lastPartyDeltas.map((delta) => ({ ...delta }))
      : [];
    syncOutput.textContent = t("sync.sending", { n: deltasToSend.length });
    const resp = await fetch("/api/local-sync/preview-job", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${window.__artistSyncToken}`,
      },
      body: JSON.stringify({
        deltas: deltasToSend,
        partyDeltas: partyDeltasToSend,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      syncOutput.innerHTML = `<span class="status-err">${t("sync.failed", { status: resp.status })}</span> ${escapeHtml(data?.error || "unknown error")}`;
      syncBtn.disabled = !canSendCurrentPreview();
      return;
    }
    const deliveryKey = data?.delivery?.delivered
      ? "sync.sentToDiscord"
      : data?.delivery?.pending
        ? "sync.deliveryPending"
        : "sync.savedForDiscord";
    syncOutput.innerHTML = `<span class="status-ok">${escapeHtml(t("sync.previewReady"))}</span> ${escapeHtml(t(deliveryKey))}`;
    syncOutput.hidden = false;
    void fileChangeMonitor?.checkNow("post-send");
  } catch (err) {
    syncOutput.innerHTML = `<span class="status-err">${t("sync.networkError")}</span> ${escapeHtml(err.message || String(err))}`;
    syncBtn.disabled = !canSendCurrentPreview();
  }
});
