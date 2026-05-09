// Local Sync web companion - Phase 3 (dry-run preview only).
// Phase 4 will add the POST /api/raid-sync wire-up.
//
// Architecture choices:
//   - vanilla JS (no React/Next/Vite). The page does 3 things: parse
//     URL token, FSA permission, sql.js query. Adding a framework would
//     ship 100kB+ of runtime for ~150 LOC of logic.
//   - sql.js loaded from CDN (cdnjs) so we don't bundle the 1.5MB WASM
//     into the bot deploy. Cached aggressively across visits.
//   - File handle persisted in IndexedDB. The browser already provides
//     persistent FSA permission ("Allow on every visit"); IndexedDB
//     just lets us reload the handle reference on next page load.

"use strict";

const $ = (id) => document.getElementById(id);
const authStatus = $("auth-status");
const fileSection = $("file-section");
const previewSection = $("preview-section");
const dropZone = $("drop-zone");
const pickFileBtn = $("pick-file-btn");
const fileMeta = $("file-meta");
const previewOutput = $("preview-output");

// ----- 1. Token parsing -----

const params = new URLSearchParams(window.location.search);
const token = params.get("token");

function decodePayload(t) {
  try {
    const parts = t.split(".");
    if (parts.length !== 2) return null;
    const padded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
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
      authStatus.innerHTML = `<span class="status-ok">Linked as Discord user <code>${payload.discordId}</code></span> · token valid for ~${minsLeft} min`;
      // Cache for the eventual POST. Phase 4 reads this back.
      window.__artistSyncToken = token;
      window.__artistDiscordId = payload.discordId;
      fileSection.hidden = false;
    }
  }
}

// ----- 2. FSA file pick / drop -----

let currentFile = null;
let currentDB = null;

async function loadFile(file) {
  currentFile = file;
  fileMeta.hidden = false;
  fileMeta.innerHTML = `Selected <strong>${file.name}</strong> · ${formatBytes(file.size)} · modified ${new Date(file.lastModified).toLocaleString()}`;
  previewSection.hidden = false;
  previewOutput.textContent = "Loading sql.js WASM (one-time, cached after)...";
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

// ----- 3. sql.js query -----

async function loadAndPreview(file) {
  if (typeof window.initSqlJs !== "function") {
    previewOutput.innerHTML = `<span class="status-err">sql.js failed to load from CDN.</span> Check network / refresh.`;
    return;
  }
  try {
    const SQL = await window.initSqlJs({
      locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`,
    });
    const buf = new Uint8Array(await file.arrayBuffer());
    currentDB = new SQL.Database(buf);
    runPreviewQuery(currentDB);
  } catch (err) {
    console.error("[local-sync] sql.js init/open failed:", err);
    previewOutput.innerHTML = `<span class="status-err">Couldn't open the DB.</span> ${err.message || err}`;
  }
}

function runPreviewQuery(db) {
  // 7-day window. encounter.last_combat_packet is millisecond unix.
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // GROUP BY boss + difficulty + cleared so the preview shows what the
  // sync would actually push: only cleared rows count toward raid
  // progress. Failed pulls are ignored.
  const sql = `
    SELECT current_boss_name AS boss,
           COALESCE(difficulty, 'Normal') AS difficulty,
           cleared,
           COUNT(*) AS n,
           MAX(last_combat_packet) AS last_ms
    FROM encounter
    WHERE last_combat_packet >= ?
      AND current_boss_name IS NOT NULL
      AND current_boss_name != ''
    GROUP BY current_boss_name, difficulty, cleared
    ORDER BY last_ms DESC
    LIMIT 100;
  `;
  let rows;
  try {
    rows = db.exec(sql, [sevenDaysAgoMs]);
  } catch (err) {
    previewOutput.innerHTML = `<span class="status-err">Query failed.</span> ${err.message || err}<br><span class="hint">Schema may have changed in your LOA Logs version. Report this in the Discord.</span>`;
    return;
  }
  if (!rows || rows.length === 0 || !rows[0].values) {
    previewOutput.innerHTML = `<span class="status-ok">No encounters in the last 7 days.</span> Nothing to sync.`;
    return;
  }
  const cleared = rows[0].values.filter((r) => r[2] === 1);
  const failed = rows[0].values.filter((r) => r[2] !== 1);
  let html = `<div class="meta">Last 7 days: <strong>${cleared.length}</strong> cleared encounter group(s), <strong>${failed.length}</strong> failed.</div>`;
  html += `<table><thead><tr><th>Boss</th><th>Difficulty</th><th>Cleared</th><th>Count</th><th>Latest</th></tr></thead><tbody>`;
  for (const row of rows[0].values) {
    const [boss, difficulty, isCleared, n, lastMs] = row;
    const ts = lastMs ? new Date(Number(lastMs)).toLocaleString() : "-";
    const status = isCleared === 1 ? "✓" : "✗";
    html += `<tr><td>${escapeHtml(boss || "?")}</td><td>${escapeHtml(difficulty)}</td><td>${status}</td><td>${n}</td><td>${ts}</td></tr>`;
  }
  html += `</tbody></table>`;
  html += `<p class="hint">Phase 4 will POST these rows to <code>/api/raid-sync</code> after mapping each boss to a raid + gate.</p>`;
  previewOutput.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
