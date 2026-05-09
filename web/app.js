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
  // GROUP BY boss + difficulty + cleared + local_player so each row in
  // the preview corresponds to one (boss, difficulty, char) pair the
  // sync would push. Failed pulls are NOT POSTed but we still show
  // them so the user has confidence the file is being read.
  // local_player is the LOA Logs column for the user's main char in
  // that encounter; fallback to empty string if the column doesn't exist
  // in older schemas (the WHERE filters those out).
  const sql = `
    SELECT current_boss_name AS boss,
           COALESCE(difficulty, 'Normal') AS difficulty,
           cleared,
           COALESCE(local_player, '') AS char_name,
           COUNT(*) AS n,
           MAX(last_combat_packet) AS last_ms
    FROM encounter
    WHERE last_combat_packet >= ?
      AND current_boss_name IS NOT NULL
      AND current_boss_name != ''
    GROUP BY current_boss_name, difficulty, cleared, char_name
    ORDER BY last_ms DESC
    LIMIT 200;
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
    lastDeltas = [];
    return;
  }
  const cleared = rows[0].values.filter((r) => r[2] === 1);
  const failed = rows[0].values.filter((r) => r[2] !== 1);
  // Build the deltas array NOW so the Sync button has data ready.
  // Only cleared rows go into deltas - failed pulls don't move raid
  // progress. Empty char_name is dropped server-side anyway, but skip
  // here too to save bytes on the wire.
  lastDeltas = cleared
    .filter((r) => r[3])
    .map((r) => ({
      boss: r[0],
      difficulty: r[1],
      cleared: 1,
      charName: r[3],
      lastClearMs: Number(r[5]) || 0,
    }));
  let html = `<div class="meta">Last 7 days: <strong>${cleared.length}</strong> cleared encounter group(s), <strong>${failed.length}</strong> failed. <strong>${lastDeltas.length}</strong> ready to sync.</div>`;
  html += `<table><thead><tr><th>Char</th><th>Boss</th><th>Difficulty</th><th>Cleared</th><th>Count</th><th>Latest</th></tr></thead><tbody>`;
  for (const row of rows[0].values) {
    const [boss, difficulty, isCleared, charName, n, lastMs] = row;
    const ts = lastMs ? new Date(Number(lastMs)).toLocaleString() : "-";
    const status = isCleared === 1 ? "✓" : "✗";
    html += `<tr><td>${escapeHtml(charName || "?")}</td><td>${escapeHtml(boss || "?")}</td><td>${escapeHtml(difficulty)}</td><td>${status}</td><td>${n}</td><td>${ts}</td></tr>`;
  }
  html += `</tbody></table>`;
  previewOutput.innerHTML = html;
  // Reveal the Sync section + enable button if we have anything to send.
  syncSection.hidden = false;
  syncBtn.disabled = lastDeltas.length === 0;
  if (lastDeltas.length === 0) {
    syncOutput.hidden = false;
    syncOutput.innerHTML = `Nothing to sync (no cleared encounters with a char name in the last 7 days).`;
  } else {
    syncOutput.hidden = true;
  }
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
