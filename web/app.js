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

// Static <html lang> + <body dir> attributes follow the active locale so
// fonts + line-breaking heuristics match. JP/Chinese-derived glyphs in
// particular benefit from the right `lang` hint for browser font fallback.
document.documentElement.setAttribute("lang", window.__artistLang || "vi");

if (!token) {
  authStatus.innerHTML = `<span class="status-err">${t("identity.noToken")}</span> ${t("identity.noTokenHint")}`;
} else if (!payload || !payload.discordId) {
  authStatus.innerHTML = `<span class="status-err">${t("identity.malformed")}</span> ${t("identity.malformedHint")}`;
} else {
  const expSec = payload.exp || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (expSec && expSec < nowSec) {
    authStatus.innerHTML = `<span class="status-err">${t("identity.expired")}</span> ${t("identity.expiredHint")}`;
  } else {
    const minsLeft = Math.max(0, Math.floor((expSec - nowSec) / 60));
    authStatus.innerHTML = `<span class="status-ok">${t("identity.linked")} <code>${escapeHtml(payload.discordId)}</code></span> · ${t("identity.tokenValid", { n: minsLeft })}`;
    // Cache for the eventual POST. Phase 4 reads this back.
    window.__artistSyncToken = token;
    window.__artistDiscordId = payload.discordId;
    fileSection.hidden = false;
  }
}

// ----- 2. FSA file pick / drop -----

async function loadFile(file) {
  fileMeta.hidden = false;
  fileMeta.innerHTML = `${t("file.selected")} <strong>${escapeHtml(file.name)}</strong> · ${formatBytes(file.size)} · ${t("file.modified")} ${new Date(file.lastModified).toLocaleString()}`;
  previewSection.hidden = false;
  await loadAndPreview(file);
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
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".db")) {
    alert(t("file.invalidExt"));
    return;
  }
  await loadFile(file);
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
    await loadFile(file);
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.error("[local-sync] file pick failed:", err);
    alert(`${t("file.pickFailed")}: ${err.message || err}`);
  }
});

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
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
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
    await sqlite3.exec(db, sql.replace("?", String(sevenDaysAgoMs)), (row, _columns) => {
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
  // Lazy-load preview-utils so the boss->raid map is only parsed when
  // there's actually something to render. Keeps the page-load lighter
  // on first visit (no file dropped yet).
  const { bucketize, groupByRaid, findUnmappedBosses, getRaidGateForBoss } = await import("/sync/preview-utils.js");
  // Build the deltas array for the Sync POST. Server re-validates +
  // re-buckets, but only mapped raid clears are sent. Failed encounters,
  // non-raid content, and rows without a local character stay client-side.
  const syncRows = rows.filter((r) => r[3] && getRaidGateForBoss(r[0]));
  lastDeltas = syncRows
    .map((r) => ({
      boss: r[0],
      difficulty: r[1],
      cleared: 1,
      charName: r[3],
      lastClearMs: Number(r[5]) || 0,
    }));
  // Bucketize for the per-raid table render. Each bucket = (char, raid,
  // mode) collapsed to its highest cleared gate, with cumulative gate
  // list. This is the EXACT shape the server's apply.js will produce -
  // the preview here mirrors what gets persisted, no drift.
  const buckets = bucketize(rows);
  const groups = groupByRaid(buckets);
  const unmappedBosses = findUnmappedBosses(rows);
  // Headline: count of distinct chars + raid clears the sync will apply.
  const distinctChars = new Set(buckets.map((b) => b.charName.toLowerCase())).size;
  let html = `<div class="meta">${t("preview.headlineCount", { chars: distinctChars, clears: buckets.length })} <span class="hint">${t("preview.schemaDebug", { table, bossCol, tsCol, charCol: charCol || "-" })}</span></div>`;
  // Empty-state when EVERY cleared row was unmapped or had no char name.
  if (groups.length === 0) {
    html += `<p class="hint" style="margin-top:12px;">${t("preview.noBucketsMatched")}</p>`;
  }
  // One table per (raid, mode). Each table shows char + cumulative
  // gates + latest clear timestamp. Matches the /raid-status raid-card
  // mental model - "this raid, this difficulty, who cleared, what gates".
  // Raid + mode labels resolve via i18n at render time so JP user sees
  // "アクト4 ハード" while EN user sees "Act 4 Hard".
  for (const group of groups) {
    const emoji = group.modeKey === "nightmare" ? "🌑" : group.modeKey === "hard" ? "⚔️" : "🛡️";
    const raidLabel = getRaidLabel(group.raidKey);
    const modeLabel = getModeLabel(group.modeKey);
    html += `<div class="raid-group">`;
    html += `<h3>${emoji} ${escapeHtml(raidLabel)} ${escapeHtml(modeLabel)} <span class="hint">· ${t("preview.raidGroupCharCount", { n: group.buckets.length })}</span></h3>`;
    html += `<table><thead><tr><th>${t("preview.colChar")}</th><th>${t("preview.colGates")}</th><th>${t("preview.colLatest")}</th></tr></thead><tbody>`;
    for (const b of group.buckets) {
      const ts = b.lastClearMs ? new Date(b.lastClearMs).toLocaleString() : "-";
      html += `<tr><td>${formatCharCell(b)}</td><td><code>${b.gates.join("+")}</code></td><td>${ts}</td></tr>`;
    }
    html += `</tbody></table>`;
    html += `</div>`;
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
  syncSection.hidden = false;
  syncBtn.disabled = lastDeltas.length === 0;
  if (lastDeltas.length === 0) {
    syncOutput.hidden = false;
    syncOutput.innerHTML = t("sync.nothingToSyncFull");
  } else {
    syncOutput.hidden = true;
  }
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
