import { t, getRaidLabel, getRaidSpecificModeLabel } from "/sync/js/core/i18n.js";
import { escapeHtml } from "/sync/js/core/html.js";
import { formatGold, formatRelativeTime } from "/sync/js/core/format.js";
import { renderCharPendingLabel, renderCharPendingRow } from "/sync/js/sync/render/char-row.js";
import { resolvePreviewLastSync } from "/sync/js/sync/preview-stats.js";

const GATE_STATE_SYMBOL = Object.freeze({
  "db-other-mode": "◐",
  "mode-conflict": "⚠",
  pending: "⏬",
  synced: "✓",
});

function gateStateSymbol(state) {
  return GATE_STATE_SYMBOL[state] || "·";
}

function groupPreviewCharactersByRoster(characters) {
  const byRoster = new Map();
  for (const character of characters) {
    const key = character.accountName || "";
    if (!byRoster.has(key)) byRoster.set(key, []);
    byRoster.get(key).push(character);
  }
  return byRoster;
}

function renderRosterCharacterLists(characters, renderTail) {
  let html = "";
  for (const [accountName, charsInRoster] of groupPreviewCharactersByRoster(characters)) {
    if (accountName) {
      html += `<div class="char-pending-roster-header">📁 <strong>${escapeHtml(accountName)}</strong></div>`;
    }
    html += `<ul class="char-pending-list">`;
    for (const character of charsInRoster) {
      const classIcon = renderClassIcon(character.className);
      const charLabel = renderCharPendingLabel(classIcon, character);
      html += renderCharPendingRow(charLabel, renderTail(character));
    }
    html += `</ul>`;
  }
  return html;
}

export function renderPreviewStats(panel, summary) {
  if (!panel) return;
  if (!summary) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const goldTotal = summary.goldDelta?.total || 0;
  const goldBound = summary.goldDelta?.boundTotal || 0;
  const goldByChar = Array.isArray(summary.goldDelta?.byChar) ? summary.goldDelta.byChar : [];
  const completion = summary.completion || {};
  const charsAfterSync = Array.isArray(summary.charsAfterSync) ? summary.charsAfterSync : [];

  // Gold chip: show the value when positive, otherwise show the localized
  // "no new gold" state so the panel still renders when the value is zero.
  // When some of it is roster-bound (normal raids), surface that portion.
  const goldBoundStr = goldBound > 0
    ? ` <span class="stat-label">(🔒 ${escapeHtml(formatGold(goldBound))} ${escapeHtml(t("preview.statsGoldBound"))})</span>`
    : "";
  const goldStr = goldTotal > 0
    ? `<span class="stat-value">${escapeHtml(formatGold(goldTotal))}${goldBoundStr}</span>`
    : `<span class="stat-value">${escapeHtml(t("preview.statsGoldEmpty"))}</span>`;

  // Last sync: pick max of local + bible timestamps; show mode label
  // so user knows which path the timestamp belongs to. Solo scope uses
  // the companion timestamp only because Bible does not ingest Solo.
  let lastSyncStr;
  const latestSync = resolvePreviewLastSync(summary);
  if (!latestSync) {
    lastSyncStr = `<span class="stat-value">${escapeHtml(t("preview.statsLastSyncNever"))}</span>`;
  } else {
    const modeLabel = t(latestSync.labelKey);
    lastSyncStr = `<span class="stat-value">${escapeHtml(formatRelativeTime(latestSync.ms) || "")} <span class="stat-label">(${escapeHtml(modeLabel)})</span></span>`;
  }

  // Completion chip uses {cleared}/{total} interpolation to bold the
  // numbers via the locale's <strong> tags. The template values are limited
  // to numbers and the `raid` unit, so the generated HTML is safe.
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
    html += `<details><summary>${escapeHtml(t("preview.statsPendingSummary", { n: charsAfterSync.length }))}</summary>`;
    html += renderRosterCharacterLists(charsAfterSync, (character) =>
      (character.raids || []).map((raid) => {
        const icon = raid.status === "done" ? "🟢" : raid.status === "partial" ? "🟡" : "⚪";
        const raidLabel = getRaidLabel(raid.raidKey);
        const modeLabel = getRaidSpecificModeLabel(raid.raidKey, raid.modeKey);
        // `incoming` = ≥1 gate in this raid+mode is in the delta. ✨
        // marker + brighter border on those pills so the user can
        // tell which raids are about to flip from this sync vs
        // pills that stay steady.
        const incomingMark = raid.incoming ? `<span class="raid-pill-incoming">✨</span> ` : "";
        const incomingClass = raid.incoming ? " raid-pill--incoming" : "";
        return `<span class="raid-pill raid-pill--${raid.status}${incomingClass}">${incomingMark}${icon} ${escapeHtml(raidLabel)} <span class="raid-pill-mode">${escapeHtml(modeLabel)}</span></span>`;
      }).join("")
    );
    html += `</details>`;
  }
  // Per-char gold breakdown - same per-roster sectioning + class icon
  // treatment as the raid status list. Gold value lives on the right as a
  // standalone pill so the eye scans "char · roster" → "gold" cleanly.
  if (goldByChar.length > 0) {
    html += `<details><summary>${escapeHtml(t("preview.statsGoldByCharSummary"))}</summary>`;
    html += renderRosterCharacterLists(
      goldByChar,
      (character) => `<span class="gold-pill">💰 ${escapeHtml(formatGold(character.gold))}</span>`
    );
    html += `</details>`;
  }
  panel.innerHTML = html;
  panel.hidden = false;
}


// Render the full preview-output panel for the current roster page.
// Bound to window.__artistRosterPage so prev/next button clicks just
// mutate that index + re-call this. Re-rendering the whole panel is
// low-cost because each raid card has few DOM nodes, and keeps the click
// handlers fresh after innerHTML rewrites.
function normalizeRosterPageIndex(diff) {
  let pageIndex = Number(window.__artistRosterPage) || 0;
  if (pageIndex < 0) pageIndex = 0;
  if (pageIndex >= diff.length) pageIndex = Math.max(0, diff.length - 1);
  window.__artistRosterPage = pageIndex;
  return pageIndex;
}

function renderPreviewHeadline(meta) {
  const headlineKey = Number(meta.clears) > 0
    ? "preview.headlineCount"
    : "preview.headlineNoSync";
  let html = `<div class="meta">${t(headlineKey, {
    chars: meta.distinctChars,
    clears: meta.clears,
  })} <span class="hint">${escapeHtml(t("preview.schemaDebug", meta.schemaDebug))}</span></div>`;
  if (Number(meta.detectedClears) > Number(meta.clears)) {
    html += `<div class="hint">${t("preview.detectedCount", {
      chars: meta.detectedChars || 0,
      clears: meta.detectedClears || 0,
    })}</div>`;
  }
  return html;
}

function renderEmptyDiffMessage(meta, rosterError) {
  if (rosterError) {
    return `<p class="hint preview-note"><span class="status-err">${t("preview.rosterUnavailable")}</span> ${escapeHtml(rosterError)}</p>`;
  }
  if (Number(meta.detectedClears) > 0) {
    return `<p class="hint preview-note">${t("preview.noRosterMatched")}</p>`;
  }
  return `<p class="hint preview-note">${t("preview.noBucketsMatched")}</p>`;
}

function getModeEmoji(modeKey) {
  if (modeKey === "nightmare") return "🌑";
  if (modeKey === "hard") return "⚔️";
  return "🛡️";
}

function renderRosterPagination(page, diffLength, pageIndex, viewMode) {
  let html = `<div class="roster-pagination">`;
  if (diffLength > 1) {
    const prevDisabled = pageIndex === 0 ? "disabled" : "";
    html += `<button class="page-btn" id="roster-prev" ${prevDisabled}>◀</button>`;
  }
  html += `<span class="roster-name">🏛️ ${escapeHtml(page.accountName)}</span>`;
  if (diffLength > 1) {
    const nextDisabled = pageIndex >= diffLength - 1 ? "disabled" : "";
    html += `<span class="page-counter">${pageIndex + 1}/${diffLength}</span>`;
    html += `<button class="page-btn" id="roster-next" ${nextDisabled}>▶</button>`;
  }
  const toggleLabel = viewMode === "char"
    ? t("preview.viewToggleToRaid")
    : t("preview.viewToggleToChar");
  const toggleEmoji = viewMode === "char" ? "🗂️" : "👤";
  html += `<button class="page-btn view-toggle" id="view-toggle">${toggleEmoji} ${escapeHtml(toggleLabel)}</button>`;
  return html + `</div>`;
}

function groupCharacterCellsByRaid(cells) {
  const grouped = new Map();
  for (const cell of cells) {
    if (!grouped.has(cell.raidKey)) grouped.set(cell.raidKey, []);
    grouped.get(cell.raidKey).push(cell);
  }
  return grouped;
}

function renderCharacterMode(cell) {
  const modeLabel = getRaidSpecificModeLabel(cell.raidKey, cell.modeKey);
  const badges = cell.gates
    .map((gate) => renderGateBadge(gate, cell.states[gate]))
    .join("");
  return `<div class="char-mode-block">`
    + `<span class="char-mode-label">${getModeEmoji(cell.modeKey)} ${escapeHtml(modeLabel)}</span>`
    + `<div class="gate-badges">${badges}</div>`
    + `</div>`;
}

function renderCharacterRaidRow(raidKey, cells) {
  return `<div class="char-raid-row">`
    + `<span class="char-raid-name">${escapeHtml(getRaidLabel(raidKey))}</span>`
    + `<div class="char-raid-modes">${cells.map(renderCharacterMode).join("")}</div>`
    + `</div>`;
}

function renderCharacterCard(character) {
  const raidRows = [...groupCharacterCellsByRaid(character.cells)]
    .map(([raidKey, cells]) => renderCharacterRaidRow(raidKey, cells))
    .join("");
  return `<div class="char-card">`
    + `<div class="char-card-head">${formatCharRowHead(character)}</div>`
    + `<div class="char-raid-grid">${raidRows}</div>`
    + `</div>`;
}

function renderCharacterCards(characters) {
  return `<div class="char-cards-grid">${characters.map(renderCharacterCard).join("")}</div>`;
}

function renderRaidCardCharacter(character) {
  const badges = character.gates
    .map((gate) => renderGateBadge(gate, character.states[gate]))
    .join("");
  return `<div class="raid-card-char">`
    + `<div class="char-info">${formatCharRowHead(character)}</div>`
    + `<div class="gate-badges">${badges}</div>`
    + `</div>`;
}

function renderRaidCard(card) {
  const raidLabel = getRaidLabel(card.raidKey);
  const modeLabel = getRaidSpecificModeLabel(card.raidKey, card.modeKey);
  return `<div class="raid-card">`
    + `<h4 class="raid-card-header">${getModeEmoji(card.modeKey)} ${escapeHtml(raidLabel)} ${escapeHtml(modeLabel)} <span class="hint">· ${t("preview.raidGroupCharCount", { n: card.chars.length })}</span></h4>`
    + card.chars.map(renderRaidCardCharacter).join("")
    + `</div>`;
}

function renderDiffAccountPage(page, diffLength, pageIndex) {
  const viewMode = window.__artistViewMode === "raid" ? "raid" : "char";
  const cards = viewMode === "char"
    ? renderCharacterCards(page.characters)
    : page.raidCards.map(renderRaidCard).join("");
  return renderDiffLegend(page)
    + renderRosterPagination(page, diffLength, pageIndex, viewMode)
    + cards;
}

function renderUnmappedBosses(unmappedBosses) {
  if (unmappedBosses.length === 0) return "";
  const items = unmappedBosses
    .map((boss) => `<li><code>${escapeHtml(boss)}</code></li>`)
    .join("");
  return `<details class="footer-details"><summary>${t("preview.unmappedSummary", {
    n: unmappedBosses.length,
  })}</summary><ul>${items}</ul><p class="hint">${t("preview.unmappedReportHint")}</p></details>`;
}

function bindDiffPageControls(previewOutput) {
  const prevBtn = document.getElementById("roster-prev");
  const nextBtn = document.getElementById("roster-next");
  const viewToggleBtn = document.getElementById("view-toggle");
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
  if (viewToggleBtn) {
    viewToggleBtn.addEventListener("click", () => {
      window.__artistViewMode = window.__artistViewMode === "raid" ? "char" : "raid";
      renderDiffPage(previewOutput);
    });
  }
}

export function renderDiffPage(previewOutput) {
  if (!previewOutput) return;
  const diff = window.__artistDiff || [];
  const meta = window.__artistMeta || { distinctChars: 0, clears: 0, schemaDebug: {} };
  const unmappedBosses = window.__artistUnmappedBosses || [];
  const rosterError = window.__artistRosterError || "";
  const pageIndex = normalizeRosterPageIndex(diff);

  let html = renderPreviewHeadline(meta);
  html += diff.length === 0
    ? renderEmptyDiffMessage(meta, rosterError)
    : renderDiffAccountPage(diff[pageIndex], diff.length, pageIndex);
  html += renderUnmappedBosses(unmappedBosses);
  previewOutput.innerHTML = html;
  bindDiffPageControls(previewOutput);
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

function renderClassIcon(className) {
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
  const symbol = gateStateSymbol(state);
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
  const items = states.map((state) => (
    `<span class="legend-item gate-${state}">${gateStateSymbol(state)} ${escapeHtml(t("diff.state." + state))}</span>`
  )).join("");
  return `<div class="diff-legend">${items}</div>`;
}
