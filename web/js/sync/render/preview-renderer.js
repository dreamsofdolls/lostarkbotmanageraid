import { t, getRaidLabel, getModeLabel } from "/sync/js/core/i18n.js";
import { escapeHtml } from "/sync/js/core/html.js";
import { formatGold, formatRelativeTime } from "/sync/js/core/format.js";
import { renderCharPendingLabel, renderCharPendingRow } from "/sync/js/sync/render/char-row.js";

export function renderPreviewStats(panel, summary) {
  if (!panel) return;
  if (!summary) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const goldTotal = summary.goldDelta?.total || 0;
  const goldByChar = Array.isArray(summary.goldDelta?.byChar) ? summary.goldDelta.byChar : [];
  const completion = summary.completion || {};
  const charsAfterSync = Array.isArray(summary.charsAfterSync) ? summary.charsAfterSync : [];
  const lastSync = summary.lastSync || {};

  // Gold chip: show value when > 0, else friendly "no new gold" copy
  // so the panel still shows up (otherwise users wonder if it loaded).
  const goldStr = goldTotal > 0
    ? `<span class="stat-value">${escapeHtml(formatGold(goldTotal))}</span>`
    : `<span class="stat-value">${escapeHtml(t("preview.statsGoldEmpty"))}</span>`;

  // Last sync: pick max of local + bible timestamps; show mode label
  // so user knows which path the timestamp belongs to.
  let lastSyncStr;
  const localMs = Number(lastSync.localSyncAt) || 0;
  const bibleMs = Number(lastSync.autoManageSyncAt) || 0;
  if (localMs === 0 && bibleMs === 0) {
    lastSyncStr = `<span class="stat-value">${escapeHtml(t("preview.statsLastSyncNever"))}</span>`;
  } else {
    const useLocal = localMs >= bibleMs;
    const ms = useLocal ? localMs : bibleMs;
    const modeLabel = useLocal
      ? t("preview.statsLastSyncLocalMode")
      : t("preview.statsLastSyncBibleMode");
    lastSyncStr = `<span class="stat-value">${escapeHtml(formatRelativeTime(ms) || "")} <span class="stat-label">(${escapeHtml(modeLabel)})</span></span>`;
  }

  // Completion chip uses {cleared}/{total} interpolation to bold the
  // numbers via the locale's <strong> tags. innerHTML-safe because we
  // control the template values (all numbers + the `raid` unit).
  const completionStr = completion.totalRaids > 0
    ? t("preview.statsCompletionFormat", {
        cleared: completion.cleared,
        total: completion.totalRaids,
        percent: completion.percent,
        projectedPercent: completion.projectedPercent,
      })
    : "—";

  let html = `<div class="stat-row">`;
  html += `<div class="stat"><span class="stat-icon">💰</span><span class="stat-label">${escapeHtml(t("preview.statsGoldLabel"))}:</span> ${goldStr}</div>`;
  html += `<div class="stat"><span class="stat-icon">🕒</span><span class="stat-label">${escapeHtml(t("preview.statsLastSyncLabel"))}:</span> ${lastSyncStr}</div>`;
  if (completion.totalRaids > 0) {
    html += `<div class="stat"><span class="stat-icon">📊</span><span class="stat-label">${escapeHtml(t("preview.statsCompletionLabel"))}:</span> <span class="stat-value">${completionStr}</span></div>`;
  }
  html += `</div>`;

  // Per-char raid status list - mirrors `/raid-status` for every
  // eligible character after sync. Group by accountName so the manager
  // view shows each roster section explicitly, like the bot embed pages.
  // Class icon prefix uses the same /sync/class-icons/<slug>.png
  // convention as the existing per-roster preview cards.
  if (charsAfterSync.length > 0) {
    const byRoster = new Map();
    for (const c of charsAfterSync) {
      const key = c.accountName || "";
      if (!byRoster.has(key)) byRoster.set(key, []);
      byRoster.get(key).push(c);
    }
    html += `<details><summary>${escapeHtml(t("preview.statsPendingSummary", { n: charsAfterSync.length }))}</summary>`;
    for (const [accountName, charsInRoster] of byRoster) {
      if (accountName) {
        html += `<div class="char-pending-roster-header">📁 <strong>${escapeHtml(accountName)}</strong></div>`;
      }
      html += `<ul class="char-pending-list">`;
      for (const c of charsInRoster) {
        const classIcon = renderClassIcon(c.className);
        const charLabel = renderCharPendingLabel(classIcon, c);
        const pillsHtml = (c.raids || []).map((r) => {
          const icon = r.status === "done" ? "🟢" : r.status === "partial" ? "🟡" : "⚪";
          const raidLabel = getRaidLabel(r.raidKey);
          const modeLabel = getModeLabel(r.modeKey);
          // `incoming` = ≥1 gate in this raid+mode is in the delta. ✨
          // marker + brighter border on those pills so the user can
          // tell which raids are about to flip from this sync vs
          // pills that stay steady.
          const incomingMark = r.incoming ? `<span class="raid-pill-incoming">✨</span> ` : "";
          const incomingClass = r.incoming ? " raid-pill--incoming" : "";
          return `<span class="raid-pill raid-pill--${r.status}${incomingClass}">${incomingMark}${icon} ${escapeHtml(raidLabel)} <span class="raid-pill-mode">${escapeHtml(modeLabel)}</span></span>`;
        }).join("");
        html += renderCharPendingRow(charLabel, pillsHtml);
      }
      html += `</ul>`;
    }
    html += `</details>`;
  }
  // Per-char gold breakdown - same per-roster sectioning + class icon
  // treatment as the raid status list. Gold value lives on the right as a
  // standalone pill so the eye scans "char · roster" → "gold" cleanly.
  if (goldByChar.length > 0) {
    const goldByRoster = new Map();
    for (const c of goldByChar) {
      const key = c.accountName || "";
      if (!goldByRoster.has(key)) goldByRoster.set(key, []);
      goldByRoster.get(key).push(c);
    }
    html += `<details><summary>${escapeHtml(t("preview.statsGoldByCharSummary"))}</summary>`;
    for (const [accountName, charsInRoster] of goldByRoster) {
      if (accountName) {
        html += `<div class="char-pending-roster-header">📁 <strong>${escapeHtml(accountName)}</strong></div>`;
      }
      html += `<ul class="char-pending-list">`;
      for (const c of charsInRoster) {
        const classIcon = renderClassIcon(c.className);
        const charLabel = renderCharPendingLabel(classIcon, c);
        const goldPill = `<span class="gold-pill">💰 ${escapeHtml(formatGold(c.gold))}</span>`;
        html += renderCharPendingRow(charLabel, goldPill);
      }
      html += `</ul>`;
    }
    html += `</details>`;
  }
  panel.innerHTML = html;
  panel.hidden = false;
}


// Render the full preview-output panel for the current roster page.
// Bound to window.__artistRosterPage so prev/next button clicks just
// mutate that index + re-call this. Re-rendering the whole panel is
// cheap (handful of DOM nodes per raid card) and keeps the click
// handlers fresh after innerHTML rewrites.
export function renderDiffPage(previewOutput) {
  if (!previewOutput) return;
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
      renderDiffPage(previewOutput);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const total = (window.__artistDiff || []).length;
      window.__artistRosterPage = Math.min(total - 1, (window.__artistRosterPage || 0) + 1);
      renderDiffPage(previewOutput);
    });
  }
  // View-toggle button: flip char-first <-> raid-first. Cheap because
  // the underlying diff already carries both projections (preview-utils
  // computes them in one pass), render just picks the right one.
  const viewToggleBtn = document.getElementById("view-toggle");
  if (viewToggleBtn) {
    viewToggleBtn.addEventListener("click", () => {
      window.__artistViewMode = window.__artistViewMode === "raid" ? "char" : "raid";
      renderDiffPage(previewOutput);
    });
  }
}

function formatCharRowHead(character) {
  const cls = character.class || "";
  // Class icon path mirrors preview-utils.js getClassInfoForChar - same
  // /sync/class-icons/<name>.png convention. Class name match is text-
  // based since the roster character.class field is the human label
  // (e.g. "Berserker") not the LOA Logs class_id integer.
  const icon = renderClassIcon(cls);
  return `<span class="char-cell">${icon}<strong>${escapeHtml(character.name)}</strong> <span class="hint">· ${character.itemLevel}</span></span>`;
}

export function renderClassIcon(className) {
  const resolveIcon = window.__artistGetClassIconForLabel;
  const iconName = typeof resolveIcon === "function" ? resolveIcon(className) : "";
  return iconName
    ? `<img class="class-icon" src="/sync/class-icons/${iconName}.png" alt="${escapeHtml(className)}" title="${escapeHtml(className)}" loading="lazy">`
    : "";
}

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
