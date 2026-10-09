// Local Reader - streaming SQLite via wa-sqlite, one-button sync.
//
// Architecture choices:
//   - vanilla JS (no React/Next/Vite). The page parses the signed URL,
//     restores FSA permission, watches encounters.db revisions, queries
//     SQLite, builds a roster diff, then syncs it with two POSTs: store the
//     delta preview as a job, then apply that job. The state machine is
//     explicit, so a UI framework would add runtime weight without improving
//     the file/query correctness boundary.
//   - wa-sqlite (asyncify build) served from this deployment. A custom
//     async VFS (web/js/sync/file/file-vfs.js) that streams from File.slice() so
//     multi-GB encounters.db files don't blow Chrome's ArrayBuffer cap
//     (sql.js, the previous library, required full-file load and broke
//     at 4 GB with NotReadableError).
//   - SQLite only fetches the B-tree pages it needs - tens of MB even
//     on a 4 GB DB. Schema-detection via PRAGMA table_info adapts the
//     query to whichever LOA Logs version wrote the file.
//   - Every screen change goes through setStage(); styles.css keys the
//     transitions off main[data-stage].
//   - Active locale comes from the JWT token payload (`lang` field
//     minted by the bot). web/js/core/i18n.js + web/js/core/locales.js power the
//     vi/jp/en string swap. data-i18n attributes in index.html drive
//     the static-text swap; dynamic UI strings call t() inline.

"use strict";

import {
  setActiveLang,
  applyDomTranslations,
  t,
  getRaidLabel,
  getRaidSpecificModeLabel,
} from "/sync/js/core/i18n.js";
import {
  bootstrapAuthSession,
  decodePayload,
  readAndScrubLocalSyncToken,
  resolveCompanionScope,
} from "/sync/js/core/auth.js";
import {
  saveHandle as savePersistedHandle,
  tryRestoreForUser,
} from "/sync/js/sync/file/file-persistence.js";
import { escapeHtml } from "/sync/js/core/html.js";
import {
  listColumns,
  quoteIdent,
  resolveEncounterSource,
} from "/sync/js/sync/sqlite-schema.js";
import {
  buildEncounterPreviewSql,
  capPartyDeltas,
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
const stage = $("stage");
const well = $("well");
const promptFace = well.querySelector(".face-prompt");
const promptTitle = $("prompt-title");
const promptHint = $("prompt-hint");
const countEl = $("count");
const syncBtn = $("sync-btn");
const doneTitle = $("done-title");
const doneRejected = $("done-rejected");
const warnEl = $("warn");
const statusEl = $("status");
const fileLine = stage.querySelector(".file-line");
const fileMeta = $("file-meta");
const changeFileBtn = $("change-file");
const whoEl = $("who");

// Cache only the last atomically committed query result so the Sync button
// can POST it without accepting data from a superseded refresh.
let lastDeltas = null;
let lastPartyDeltas = null;
let lastClearCount = 0;
let previewUtilsPromise = null;
let selectedLocalFile = null;
let selectedFileHandle = null;
let selectedFileRevision = null;
let lastRenderedRevision = null;
let fileChangeMonitor = null;
let selectionSerial = 0;
let sqliteRuntimePromise = null;
let previewRetryTimer = null;
let previewRetryAttempts = 0;
// The job this page stored and has not seen applied. A retry must reuse it:
// the gates an earlier attempt wrote reach party propagation only through
// the same job, and a new job would supersede it.
let pendingJobId = null;
// A remembered file whose read permission needs a click to re-grant.
let pendingRestoreHandle = null;
let currentPrompt = { titleKey: "well.drop", hintKey: "well.dropHint" };
let shownCount = 0;
let countFrame = 0;
let dragDepth = 0;
// True from a Sync click until its requests settle. The pre-send refresh
// commits a preview mid-click, and that commit must not move the stage.
let sendInFlight = false;
const PRE_SEND_CHANGE_SETTLE_MS = 80;
const COUNT_UP_MS = 650;
const COUNT_STAGES = new Set(["ready", "syncing", "error"]);
const DROP_STAGES = new Set(["empty", "restore", "problem", "ready", "nothing", "done", "error"]);
// Drop stages whose well shows the text prompt, which can swap to the drag hint.
const DROP_PROMPT_STAGES = new Set(["empty", "restore", "problem", "nothing"]);
// The file time follows the page language, not the browser's, so it matches
// the copy around it. "jp" is not a BCP 47 tag.
const TIME_LOCALES = { vi: "vi-VN", jp: "ja-JP", en: "en-US" };

class ApiError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
  }
}

function makeAbortError(message = "preview superseded") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function makeProblemError(problemKey, message) {
  const error = new Error(message);
  error.problemKey = problemKey;
  return error;
}

function throwIfPreviewSuperseded(context, expectedSelection = selectionSerial) {
  if (context?.signal?.aborted
      || (typeof context?.isCurrent === "function" && !context.isCurrent())
      || expectedSelection !== selectionSerial) {
    throw makeAbortError();
  }
}

// ----- Stage rendering -----

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function updateSyncButton() {
  const current = stage.dataset.stage;
  let labelKey = "sync.btn";
  if (current === "syncing") labelKey = "sync.syncing";
  else if (current === "error" && pendingJobId) labelKey = "sync.retry";
  syncBtn.textContent = t(labelKey);
  syncBtn.disabled = !(current === "ready" || current === "error")
    || sendInFlight
    || !previewRefreshRunner.isIdle()
    || lastRenderedRevision?.writeVersion === 2
    || (!pendingJobId && !(lastDeltas?.length > 0));
}

function setStage(next) {
  if (!COUNT_STAGES.has(stage.dataset.stage) && COUNT_STAGES.has(next)) resetCount();
  stage.dataset.stage = next;
  well.disabled = !(next === "empty" || next === "restore" || next === "problem");
  updateSyncButton();
}

// A Sync click, or a job waiting for its retry, owns the stage. A refresh
// meanwhile only updates the preview data; the retry applies the stored job
// and the re-read after it shows anything newer.
function syncOwnsStage() {
  return sendInFlight || pendingJobId !== null;
}

function setBusy(busy) {
  stage.dataset.busy = busy ? "true" : "false";
}

function renderPromptText(titleKey, hintKey) {
  promptTitle.textContent = t(titleKey);
  promptHint.textContent = hintKey ? t(hintKey) : "";
  // Restart the text fade so a swapped prompt reads as a new line.
  promptFace.classList.remove("swap");
  void promptFace.offsetWidth;
  promptFace.classList.add("swap");
}

function showPrompt(titleKey, hintKey) {
  currentPrompt = { titleKey, hintKey };
  renderPromptText(titleKey, hintKey);
}

function resetCount() {
  cancelAnimationFrame(countFrame);
  shownCount = 0;
  countEl.textContent = "0";
}

function showCount(target) {
  cancelAnimationFrame(countFrame);
  const from = shownCount;
  shownCount = target;
  if (from === target || reducedMotion()) {
    countEl.textContent = String(target);
    return;
  }
  const startedAt = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - startedAt) / COUNT_UP_MS);
    const eased = progress === 1 ? 1 : 1 - 2 ** (-10 * progress);
    countEl.textContent = String(Math.round(from + (target - from) * eased));
    if (progress < 1) countFrame = requestAnimationFrame(step);
  };
  countFrame = requestAnimationFrame(step);
}

function setStatus(tone, key, vars) {
  statusEl.hidden = false;
  statusEl.dataset.tone = tone;
  statusEl.textContent = t(key, vars);
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.textContent = "";
  delete statusEl.dataset.tone;
}

function renderFileLine(file, live) {
  const time = new Date(file.lastModified)
    .toLocaleTimeString(TIME_LOCALES[window.__artistLang], { hour: "2-digit", minute: "2-digit" });
  fileMeta.textContent = t("file.updated", { time });
  fileLine.dataset.live = live ? "live" : "static";
}

function renderConflictWarning(conflicts) {
  if (conflicts.length === 0) {
    warnEl.hidden = true;
    warnEl.textContent = "";
    return;
  }
  const [first] = conflicts;
  let text = t("sync.conflict", {
    char: first.charName,
    raid: getRaidLabel(first.raidKey),
    to: getRaidSpecificModeLabel(first.raidKey, first.modeKey),
    from: getRaidSpecificModeLabel(first.raidKey, first.replacedModeKey),
  });
  if (conflicts.length > 1) text += ` ${t("sync.conflictMore", { n: conflicts.length - 1 })}`;
  warnEl.textContent = text;
  warnEl.hidden = false;
}

function showEmpty() {
  setStage("empty");
  showPrompt("well.drop", "well.dropHint");
}

function showProblem(problemKey) {
  setStage("problem");
  showPrompt(problemKey, `${problemKey}Hint`);
}

// kind: noToken | malformed | expired | revoked | disabled
function showBlocked(kind) {
  stopFileMonitoring();
  // A file read still in flight must not come back and replace this screen.
  selectionSerial += 1;
  resetSyncSurface({ keepFile: false });
  pendingRestoreHandle = null;
  clearStatus();
  setBusy(false);
  setStage("blocked");
  showPrompt(`identity.${kind}`, `identity.${kind}Hint`);
}

function blockedKindForResponse(status, error = "") {
  if (status === 409) return "disabled";
  if (status !== 401) return null;
  if (/revoked/.test(error)) return "revoked";
  if (/expired/.test(error)) return "expired";
  return "malformed";
}

// ----- Preview state -----

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

function loadPreviewUtils() {
  if (!previewUtilsPromise) {
    previewUtilsPromise = import("/sync/js/sync/preview-utils.js").then(async (mod) => {
      await mod.loadCatalog();
      return mod;
    }).catch((err) => {
      previewUtilsPromise = null;
      throw err;
    });
  }
  return previewUtilsPromise;
}

const previewRefreshRunner = createLatestOnlyRunner(runPreviewRefresh);

function resetSyncSurface({ keepFile = true } = {}) {
  clearPreviewRetry();
  previewRefreshRunner.invalidate();
  if (!keepFile) {
    selectedLocalFile = null;
    selectedFileHandle = null;
    selectedFileRevision = null;
  }
  lastDeltas = null;
  lastPartyDeltas = null;
  lastRenderedRevision = null;
  lastClearCount = 0;
  pendingJobId = null;
  renderConflictWarning([]);
}

function queuePreviewRefresh(snapshot, {
  reason = "manual",
  showLoading = false,
  expectedSelection = selectionSerial,
  scheduleOnFailure = true,
} = {}) {
  if (!snapshot?.file || !snapshot?.revision) return Promise.resolve(null);
  if (reason !== "retry") clearPreviewRetry();
  if (showLoading) {
    setStage("reading");
    showPrompt("well.reading", "well.readingHint");
  }
  setBusy(true);
  updateSyncButton();
  const promise = previewRefreshRunner.request({
    ...snapshot,
    handle: selectedFileHandle,
    reason,
    expectedSelection,
  });
  promise.catch((error) => {
    if (error?.name === "AbortError" || expectedSelection !== selectionSerial) return;
    console.error("[local-sync] preview refresh failed:", error);
    if (!syncOwnsStage()) showProblem(error.problemKey || "problem.openFailed");
    if (scheduleOnFailure && !error.problemKey) schedulePreviewRetry(expectedSelection);
  }).finally(() => {
    if (previewRefreshRunner.isIdle()) setBusy(false);
    updateSyncButton();
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
//   - no token present (page opened without a Discord link)
//   - token is malformed (bad payload)
//   - token doesn't carry lang (legacy mint before Phase i18n)
window.__artistSyncScope = syncScope;
setActiveLang(payload?.lang || "vi");
applyDomTranslations();

// Static <html lang> + <body dir> attributes follow the active locale so
// fonts + line-breaking heuristics match. JP/Chinese-derived glyphs in
// particular benefit from the right `lang` hint for browser font fallback.
document.documentElement.setAttribute("lang", window.__artistLang || "vi");

const authSession = bootstrapAuthSession({
  token,
  payload,
  whoEl,
  t,
  escapeHtml,
  onExpire: () => showBlocked("expired"),
});

// ----- 2. File pick / drop / restore -----

async function loadFile(file, { handle = null } = {}) {
  stopFileMonitoring();
  selectionSerial += 1;
  const expectedSelection = selectionSerial;
  resetSyncSurface({ keepFile: false });
  pendingRestoreHandle = null;
  clearStatus();
  const revision = await readFileRevision(file);
  // Auto-restore and a user-initiated picker can overlap during page startup.
  // Whichever selection started last owns the UI; an older getFile()/header
  // read must never come back later and replace it.
  if (expectedSelection !== selectionSerial) return;
  selectedLocalFile = file;
  selectedFileHandle = handle;
  selectedFileRevision = revision;
  renderFileLine(file, Boolean(handle));
  if (handle) {
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
        } else if (type === "error") {
          setStatus("warn", "file.liveRetrying");
        }
      },
    });
    fileChangeMonitor.start({ baselineRevision: selectedFileRevision });
  } else {
    setStatus("info", "file.liveStatic");
  }
  await activateSyncPreview(file, { revision: selectedFileRevision }).catch(() => {
    // queuePreviewRefresh already rendered the failure. Keep the selected
    // handle alive so the monitor can retry after the file settles.
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

async function openPicker() {
  if (typeof window.showOpenFilePicker !== "function") {
    setStatus("warn", "file.fsaUnavailable");
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
    setStatus("error", "file.pickFailed", { error: err?.message || String(err) });
  }
}

async function restoreRememberedFile() {
  const handle = pendingRestoreHandle;
  try {
    const permission = await handle.requestPermission({ mode: "read" });
    if (permission !== "granted") {
      setStatus("warn", "file.restoreDenied");
      return;
    }
    await loadFile(await handle.getFile(), { handle });
  } catch (err) {
    console.warn("[local-sync] restore-permission failed:", err?.message || err);
    setStatus("error", "file.pickFailed", { error: err?.message || String(err) });
  }
}

well.addEventListener("click", () => {
  // The permission prompt only opens inside this click's user gesture.
  if (stage.dataset.stage === "restore" && pendingRestoreHandle) {
    void restoreRememberedFile();
    return;
  }
  void openPicker();
});
changeFileBtn.addEventListener("click", () => {
  void openPicker();
});

function canAcceptDrop() {
  return DROP_STAGES.has(stage.dataset.stage) && !sendInFlight;
}

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function setDragging(dragging) {
  const active = dragging && canAcceptDrop();
  if (active) stage.dataset.drag = "on";
  else delete stage.dataset.drag;
  if (!DROP_PROMPT_STAGES.has(stage.dataset.stage)) return;
  if (active) renderPromptText("well.dragging", null);
  else renderPromptText(currentPrompt.titleKey, currentPrompt.hintKey);
}

document.addEventListener("dragenter", (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  if (dragDepth === 1) setDragging(true);
});
document.addEventListener("dragover", (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = canAcceptDrop() ? "copy" : "none";
});
document.addEventListener("dragleave", (e) => {
  if (!hasDraggedFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDragging(false);
});
document.addEventListener("drop", async (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  if (!canAcceptDrop()) return;
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
    setStatus("error", "file.invalidExt");
    return;
  }
  await loadFile(file, { handle });
});

// Restore-on-load: bring back the previously picked file when the same user
// opens a fresh link. The browser's persistent FSA permission ("Allow on
// every visit") makes this seamless when granted; otherwise the well asks
// for a click so requestPermission() runs inside a user gesture.
async function attemptRestoreFromIdb() {
  const expectedRestoreSelection = selectionSerial;
  let restore;
  try {
    restore = await tryRestoreForUser(window.__artistDiscordId);
  } catch (err) {
    console.warn("[local-sync] restore lookup failed:", err?.message || err);
    return;
  }
  // A manual pick that happened while IndexedDB was opening always outranks
  // the automatic restore started at page boot.
  if (expectedRestoreSelection !== selectionSerial || selectedLocalFile) return;
  if (!restore) return;
  if (restore.granted) {
    try {
      const file = await restore.handle.getFile();
      if (expectedRestoreSelection !== selectionSerial || selectedLocalFile) return;
      await loadFile(file, { handle: restore.handle });
    } catch (err) {
      console.warn("[local-sync] auto-restore getFile failed:", err?.message || err);
    }
    return;
  }
  pendingRestoreHandle = restore.handle;
  setStage("restore");
  showPrompt("well.restore", "well.restoreHint");
}

if (authSession.state.kind === "ok") {
  showEmpty();
  attemptRestoreFromIdb().catch((err) => {
    console.warn("[local-sync] restore attempt threw:", err?.message || err);
  });
} else {
  showBlocked(authSession.state.kind);
}

window.addEventListener("beforeunload", () => {
  stopFileMonitoring();
  clearPreviewRetry();
  previewRefreshRunner.invalidate();
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
    return { kind: "problem", key: "problem.notLoaLogs" };
  }
  const source = resolveEncounterSource({ previewCols, encounterCols });
  if (!source) {
    // Column lists go to the console for bug reports; the page stays short.
    console.warn("[local-sync] encounter columns missing:", {
      encounter_preview: [...previewCols],
      encounter: [...encounterCols],
    });
    return { kind: "problem", key: "problem.schema" };
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
    return { kind: "problem", key: "problem.soloDifficulty" };
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
    console.error("[local-sync] encounter query failed:", { table, bossCol, tsCol }, err);
    throw makeProblemError("problem.schema", err?.message || String(err));
  }
  throwIfPreviewSuperseded(context, expectedSelection);
  const scopedRows = filterRowsForSyncScope(rows, syncScope);
  if (scopedRows.length === 0) return { kind: "none" };
  return { kind: "rows", rows: scopedRows };
}

// Pure-data half of the preview pipeline. It deliberately returns a state
// object instead of mutating the DOM: only runPreviewRefresh may commit, after
// one final file-revision check proves the SQLite snapshot is still current.
async function fetchRosterSnapshot(context) {
  try {
    const resp = await fetch("/api/me/roster", {
      signal: context?.signal,
      headers: { "Authorization": `Bearer ${window.__artistSyncToken}` },
    });
    const data = await resp.json().catch(() => null);
    if (resp.ok) {
      return { rosterAccounts: Array.isArray(data?.accounts) ? data.accounts : [] };
    }
    const rosterError = data?.error || `HTTP ${resp.status}`;
    console.warn("[local-sync] roster fetch failed:", resp.status, rosterError);
    return {
      rosterAccounts: [],
      rosterError,
      blockedKind: blockedKindForResponse(resp.status, rosterError),
    };
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    console.warn("[local-sync] roster fetch threw:", err?.message || err);
    return { rosterAccounts: [], rosterError: err?.message || String(err) };
  }
}

function collectModeConflicts(diff, actionableKeys, makeBucketKey) {
  const conflicts = [];
  for (const account of diff) {
    for (const character of account.characters || []) {
      for (const cell of character.cells || []) {
        if (!cell.replacedModeKey) continue;
        if (!actionableKeys.has(makeBucketKey(character.name, cell.raidKey, cell.modeKey))) continue;
        conflicts.push({
          charName: character.name,
          raidKey: cell.raidKey,
          modeKey: cell.modeKey,
          replacedModeKey: cell.replacedModeKey,
        });
      }
    }
  }
  return conflicts;
}

async function buildPreviewStateFromRows(
  rows,
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
    getRaidGateForBoss,
    buildDiff,
    normalizeDifficulty,
    makeBucketKey,
    buildActionableBucketKeySet,
    currentWeeklyResetStartMs,
  } = await utilsPromise;
  throwIfPreviewSuperseded(context, expectedSelection);
  const syncRows = rows.filter((r) => (
    Number(r[2]) === 1 && r[3] && getRaidGateForBoss(r[0])
  ));
  const buckets = bucketize(rows);
  const { rosterAccounts, rosterError, blockedKind } = await rosterPromise;
  throwIfPreviewSuperseded(context, expectedSelection);
  const diff = buildDiff(rosterAccounts, buckets, {
    allowedModeKeys: syncScope === "solo" ? ["solo"] : null,
    currentWeekStartMs: currentWeeklyResetStartMs(),
  });
  // Full Local Sync keeps its intentional mode-switch behavior. The
  // Auto-sync companion never submits a Solo clear that would replace
  // positive progress already stored under another difficulty.
  const includeModeConflict = syncScope !== "solo";
  const actionableKeys = buildActionableBucketKeySet(diff, { includeModeConflict });
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
  const partyDeltas = capPartyDeltas(partyBuckets
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
    })));
  return {
    deltas,
    partyDeltas,
    clearCount: syncableBuckets.length,
    conflicts: includeModeConflict ? collectModeConflicts(diff, actionableKeys, makeBucketKey) : [],
    rosterError,
    blockedKind,
  };
}

function commitPreview(result) {
  if (result.kind === "problem") {
    lastDeltas = [];
    lastPartyDeltas = [];
    lastClearCount = 0;
    if (!syncOwnsStage()) showProblem(result.key);
    return;
  }
  const state = result.kind === "rows" ? result.state : null;
  lastDeltas = state?.deltas || [];
  lastPartyDeltas = state?.partyDeltas || [];
  lastClearCount = state?.clearCount || 0;
  renderConflictWarning(state?.conflicts || []);
  if (syncOwnsStage()) return;
  const current = stage.dataset.stage;
  if (lastClearCount > 0) {
    if (current !== "ready") setStage("ready");
    showCount(lastClearCount);
  } else if (current !== "done") {
    // After a sync the next read finds nothing new; the stamp stays up.
    setStage("nothing");
    showPrompt("well.nothing", "well.nothingHint");
  }
}

async function runPreviewRefresh(request, context) {
  const {
    file,
    revision,
    handle,
    expectedSelection,
  } = request;
  throwIfPreviewSuperseded(context, expectedSelection);

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
    ? await buildPreviewStateFromRows(queryResult.rows, context, expectedSelection, {
        previewUtilsReady,
        rosterSnapshotReady,
      })
    : null;
  throwIfPreviewSuperseded(context, expectedSelection);
  if (previewState?.blockedKind) {
    showBlocked(previewState.blockedKind);
    throw makeAbortError("link no longer valid");
  }

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
  // A roster read that failed would turn every clear into "not in roster".
  // Keep the last committed preview and try again instead.
  if (previewState?.rosterError) {
    setStatus("warn", "sync.rosterRetrying");
    schedulePreviewRetry(expectedSelection);
    return { revision, actionable: lastDeltas?.length || 0 };
  }

  lastRenderedRevision = revision;
  selectedLocalFile = file;
  selectedFileRevision = revision;
  renderFileLine(file, Boolean(handle));
  commitPreview(previewState ? { kind: "rows", state: previewState } : queryResult);
  fileChangeMonitor?.setBaseline(revision);

  clearPreviewRetry();
  if (!handle) {
    setStatus("info", "file.liveStatic");
  } else if (revision.writeVersion === 2) {
    setStatus("warn", "file.liveWalWarning");
  } else if (!syncOwnsStage()) {
    clearStatus();
  }
  return { revision, actionable: lastDeltas.length };
}

// ----- 4. Sync -----

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

async function postJson(path, body) {
  const resp = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${window.__artistSyncToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new ApiError(resp.status, data?.error);
  return data;
}

async function createPreviewJob() {
  const data = await postJson("/api/local-sync/preview-job", {
    deltas: lastDeltas.map((delta) => ({ ...delta })),
    partyDeltas: (lastPartyDeltas || []).map((delta) => ({ ...delta })),
  });
  return data.jobId;
}

// Back from a Sync attempt that wrote nothing, to whatever the current
// preview shows.
function returnToPreview(tone, key) {
  if (lastClearCount > 0) {
    setStage("ready");
    showCount(lastClearCount);
  } else {
    setStage("nothing");
    showPrompt("well.nothing", "well.nothingHint");
  }
  if (key) setStatus(tone, key);
}

function refreshSelectedFile() {
  if (selectedFileHandle) {
    void readFileHandleSnapshot(selectedFileHandle)
      .then((snapshot) => queuePreviewRefresh(snapshot, { reason: "stale-job" }))
      .catch((err) => console.warn("[local-sync] stale-job refresh failed:", err?.message || err));
  } else if (selectedLocalFile && selectedFileRevision) {
    void queuePreviewRefresh({ file: selectedLocalFile, revision: selectedFileRevision }, { reason: "stale-job" });
  }
}

function renderApplyOutcome(outcome) {
  if (outcome.state === "applied") {
    pendingJobId = null;
    lastDeltas = [];
    lastPartyDeltas = [];
    lastClearCount = 0;
    // Only a number is interpolated into the markup of done.title.
    doneTitle.innerHTML = t("done.title", { n: Number(outcome.written?.raids) || 0 });
    const rejected = Number(outcome.rejected) || 0;
    doneRejected.hidden = rejected === 0;
    doneRejected.textContent = rejected > 0 ? t("done.rejected", { n: rejected }) : "";
    clearStatus();
    setStage("done");
    // Re-read against the updated roster. A clear logged during the sync may
    // already sit behind the monitor baseline, so no file change would show it.
    refreshSelectedFile();
    return;
  }
  if (outcome.retryable) {
    const written = Number(outcome.written?.raids) || 0;
    setStage("error");
    if (written > 0) setStatus("error", "sync.partial", { done: written, total: lastClearCount });
    else setStatus("error", "sync.retryable");
    return;
  }
  if (outcome.state === "busy" || outcome.state === "applying") {
    setStage("error");
    setStatus("warn", "sync.busy");
    return;
  }
  // expired, superseded, cancelled or failed: this job can no longer be
  // applied, so the next Sync builds a fresh one from a new read.
  pendingJobId = null;
  setStage("error");
  setStatus("warn", "sync.stale");
  refreshSelectedFile();
}

function renderSyncError(err) {
  const blockedKind = err instanceof ApiError ? blockedKindForResponse(err.status, err.message) : null;
  if (blockedKind) {
    showBlocked(blockedKind);
    return;
  }
  if (err instanceof ApiError && err.status === 404) {
    pendingJobId = null;
    setStage("error");
    setStatus("warn", "sync.stale");
    refreshSelectedFile();
    return;
  }
  setStage("error");
  if (err instanceof ApiError) setStatus("error", "sync.failed", { status: err.status });
  else setStatus("error", "sync.networkError");
}

syncBtn.addEventListener("click", async () => {
  if (sendInFlight) return;
  sendInFlight = true;
  // A blocked link or another picked file resets the selection mid-click, and
  // this click's outcome must not replace that screen.
  const clickSelection = selectionSerial;
  clearStatus();
  setStage("syncing");
  try {
    if (!pendingJobId) {
      const fresh = await ensureFreshPreviewBeforeSend();
      if (clickSelection !== selectionSerial) return;
      if (!fresh) {
        returnToPreview("warn", "sync.fileBusy");
        return;
      }
      if (lastRenderedRevision?.writeVersion === 2) {
        returnToPreview("warn", "sync.walUnsafe");
        return;
      }
      if (!(lastDeltas?.length > 0)) {
        returnToPreview();
        return;
      }
      const jobId = await createPreviewJob();
      if (clickSelection !== selectionSerial) return;
      pendingJobId = jobId;
    }
    const outcome = await postJson("/api/local-sync/apply", { jobId: pendingJobId });
    if (clickSelection !== selectionSerial) return;
    renderApplyOutcome(outcome);
  } catch (err) {
    console.error("[local-sync] sync failed:", err);
    if (clickSelection !== selectionSerial) return;
    renderSyncError(err);
  } finally {
    sendInFlight = false;
    updateSyncButton();
  }
});
