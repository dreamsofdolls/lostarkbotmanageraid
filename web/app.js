// Local Sync web companion - Phase 4.5 (streaming SQLite via wa-sqlite).
//
// Architecture choices:
//   - vanilla JS (no React/Next/Vite). The page does 4 things: parse
//     URL token, FSA permission, sql.js query, POST sync. Adding a
//     framework would ship 100kB+ of runtime for ~250 LOC of logic.
//   - wa-sqlite (asyncify build) loaded from jsdelivr. We use a custom
//     async VFS (web/file-vfs.js) that streams from File.slice() so
//     multi-GB encounters.db files don't blow Chrome's ArrayBuffer cap
//     (sql.js, the previous library, required full-file load and broke
//     at 4 GB with NotReadableError).
//   - SQLite only fetches the B-tree pages it needs - tens of MB even
//     on a 4 GB DB. Schema-detection via PRAGMA table_info adapts the
//     query to whichever LOA Logs version wrote the file.

"use strict";

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

// ----- 1. Token parsing -----

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

if (!token) {
  authStatus.innerHTML = `<span class="status-err">No token in URL.</span> Run <code>/raid-auto-manage action:local-on</code> in Discord and click the link in the embed.`;
} else {
  const payload = decodePayload(token);
  if (!payload || !payload.discordId) {
    authStatus.innerHTML = `<span class="status-err">Token malformed.</span> Re-run <code>/raid-auto-manage action:local-on</code> for a fresh link.`;
  } else {
    const expSec = payload.exp || 0;
    const nowSec = Math.floor(Date.now() / 1000);
    if (expSec && expSec < nowSec) {
      authStatus.innerHTML = `<span class="status-err">Token expired.</span> Re-run <code>/raid-auto-manage action:local-on</code> for a fresh link.`;
    } else {
      const minsLeft = Math.max(0, Math.floor((expSec - nowSec) / 60));
      authStatus.innerHTML = `<span class="status-ok">Linked as Discord user <code>${escapeHtml(payload.discordId)}</code></span> · token valid for ~${minsLeft} min`;
      // Cache for the eventual POST. Phase 4 reads this back.
      window.__artistSyncToken = token;
      window.__artistDiscordId = payload.discordId;
      fileSection.hidden = false;
    }
  }
}

// ----- 2. FSA file pick / drop -----

async function loadFile(file) {
  fileMeta.hidden = false;
  fileMeta.innerHTML = `Selected <strong>${escapeHtml(file.name)}</strong> · ${formatBytes(file.size)} · modified ${new Date(file.lastModified).toLocaleString()}`;
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
    alert("Please drop a .db file (encounters.db from LOA Logs).");
    return;
  }
  await loadFile(file);
});

pickFileBtn.addEventListener("click", async () => {
  if (typeof window.showOpenFilePicker !== "function") {
    alert(
      "File System Access API is not available in this browser. Use Chrome / Edge, or Brave with the file-system-access-api flag enabled."
    );
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
    alert(`File pick failed: ${err.message || err}`);
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
  previewOutput.textContent = "Loading SQLite WASM (one-time, cached after)...";
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
    previewOutput.innerHTML = `<span class="status-err">Couldn't open the DB.</span> ${escapeHtml(err.message || String(err))}<br><span class="hint">Open DevTools (F12) -> Console for full stack trace.</span>`;
  }
}

// Query the encounter table. Schema between LOA Logs versions has
// shifted (e.g. current_boss_name vs current_boss, last_combat_packet
// vs fight_start), so we PRAGMA table_info first and pick column names
// that actually exist - graceful across versions.
async function runPreviewQuery(sqlite3, db) {
  const cols = await listColumns(sqlite3, db, "encounter");
  if (cols.size === 0) {
    previewOutput.innerHTML = `<span class="status-err">No 'encounter' table found.</span> This file might not be a LOA Logs encounters.db.`;
    lastDeltas = [];
    return;
  }
  // Column-name detection. Newer LOA Logs uses current_boss_name +
  // last_combat_packet; older builds (and la-utils' Zod schema) use
  // current_boss + fight_start. Pick whichever exists.
  const bossCol = cols.has("current_boss_name") ? "current_boss_name" : (cols.has("current_boss") ? "current_boss" : null);
  const tsCol = cols.has("last_combat_packet") ? "last_combat_packet" : (cols.has("fight_start") ? "fight_start" : null);
  const charCol = cols.has("local_player") ? "local_player" : (cols.has("local_player_name") ? "local_player_name" : null);
  const diffCol = cols.has("difficulty") ? "difficulty" : null;
  const clearedCol = cols.has("cleared") ? "cleared" : null;
  if (!bossCol || !tsCol) {
    const colPreview = [...cols].slice(0, 12).map(escapeHtml).join(", ");
    previewOutput.innerHTML = `<span class="status-err">Encounter table is missing required columns.</span><br>Found: ${colPreview}${cols.size > 12 ? "..." : ""}<br><span class="hint">Need at least a boss-name column and a timestamp column. Schema may have changed - report in Discord with this list.</span>`;
    lastDeltas = [];
    return;
  }
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sql = `
    SELECT ${bossCol} AS boss,
           ${diffCol ? `COALESCE(${diffCol}, 'Normal')` : `'Normal'`} AS difficulty,
           ${clearedCol ? clearedCol : `1`} AS cleared,
           ${charCol ? `COALESCE(${charCol}, '')` : `''`} AS char_name,
           COUNT(*) AS n,
           MAX(${tsCol}) AS last_ms
    FROM encounter
    WHERE ${tsCol} >= ?
      AND ${bossCol} IS NOT NULL
      AND ${bossCol} != ''
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
    previewOutput.innerHTML = `<span class="status-err">Query failed.</span> ${escapeHtml(err.message || String(err))}<br><span class="hint">Boss column: <code>${bossCol}</code>, ts column: <code>${tsCol}</code>. Schema mismatch?</span>`;
    return;
  }
  if (rows.length === 0) {
    previewOutput.innerHTML = `<span class="status-ok">No encounters in the last 7 days.</span> Nothing to sync.`;
    lastDeltas = [];
    return;
  }
  // sqlite3.exec passes row values as an array in column order: [boss, difficulty, cleared, char_name, n, last_ms]
  const cleared = rows.filter((r) => Number(r[2]) === 1);
  const failed = rows.filter((r) => Number(r[2]) !== 1);
  lastDeltas = cleared
    .filter((r) => r[3])
    .map((r) => ({
      boss: r[0],
      difficulty: r[1],
      cleared: 1,
      charName: r[3],
      lastClearMs: Number(r[5]) || 0,
    }));
  let html = `<div class="meta">Last 7 days: <strong>${cleared.length}</strong> cleared encounter group(s), <strong>${failed.length}</strong> failed. <strong>${lastDeltas.length}</strong> ready to sync. <span class="hint">(boss=<code>${escapeHtml(bossCol)}</code> ts=<code>${escapeHtml(tsCol)}</code> char=<code>${escapeHtml(charCol || "—")}</code>)</span></div>`;
  html += `<table><thead><tr><th>Char</th><th>Boss</th><th>Difficulty</th><th>Cleared</th><th>Count</th><th>Latest</th></tr></thead><tbody>`;
  for (const row of rows) {
    const [boss, difficulty, isCleared, charName, n, lastMs] = row;
    const ts = lastMs ? new Date(Number(lastMs)).toLocaleString() : "-";
    const status = Number(isCleared) === 1 ? "✓" : "✗";
    html += `<tr><td>${escapeHtml(charName || "?")}</td><td>${escapeHtml(boss || "?")}</td><td>${escapeHtml(difficulty)}</td><td>${status}</td><td>${n}</td><td>${ts}</td></tr>`;
  }
  html += `</tbody></table>`;
  previewOutput.innerHTML = html;
  syncSection.hidden = false;
  syncBtn.disabled = lastDeltas.length === 0;
  if (lastDeltas.length === 0) {
    syncOutput.hidden = false;
    syncOutput.innerHTML = `Nothing to sync (no cleared encounters with a char name in the last 7 days).`;
  } else {
    syncOutput.hidden = true;
  }
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
    syncOutput.innerHTML = `<span class="status-err">No token cached.</span> Refresh the link from Discord.`;
    return;
  }
  if (!Array.isArray(lastDeltas) || lastDeltas.length === 0) {
    syncOutput.hidden = false;
    syncOutput.innerHTML = `Nothing to sync.`;
    return;
  }
  syncBtn.disabled = true;
  syncOutput.hidden = false;
  syncOutput.textContent = `Sending ${lastDeltas.length} delta(s) to Artist...`;
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
      syncOutput.innerHTML = `<span class="status-err">Sync failed (HTTP ${resp.status}).</span> ${escapeHtml(data?.error || "unknown error")}`;
      syncBtn.disabled = false;
      return;
    }
    const a = (data.applied || []).length;
    const s = (data.skipped || []).length;
    const u = (data.unmapped || []).length;
    const r = (data.rejected || []).length;
    let html = `<span class="status-ok">Sync complete!</span> <strong>${a}</strong> applied, <strong>${s}</strong> already complete, <strong>${u}</strong> unmapped, <strong>${r}</strong> rejected.`;
    if (a > 0) {
      html += `<br><br><strong>Applied:</strong><ul>`;
      for (const x of data.applied) html += `<li>${escapeHtml(x.charName)} - ${escapeHtml(x.raidKey)}/${escapeHtml(x.modeKey)} ${x.gates.join(",")}</li>`;
      html += `</ul>`;
    }
    if (r > 0) {
      html += `<br><strong>Rejected:</strong><ul>`;
      for (const x of data.rejected) html += `<li>${escapeHtml(x.charName)} - ${escapeHtml(x.reason)}${x.error ? ` (${escapeHtml(x.error)})` : ""}</li>`;
      html += `</ul>`;
    }
    if (u > 0) {
      html += `<br><span class="hint">Unmapped bosses (need bot-side aliases): ${data.unmapped.slice(0, 5).map((x) => escapeHtml(x.boss)).join(", ")}${u > 5 ? `, …+${u - 5}` : ""}</span>`;
    }
    syncOutput.innerHTML = html;
  } catch (err) {
    syncOutput.innerHTML = `<span class="status-err">Network error.</span> ${escapeHtml(err.message || String(err))}`;
    syncBtn.disabled = false;
  }
});
