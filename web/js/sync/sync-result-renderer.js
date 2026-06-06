import { t, getRaidLabel, getModeLabel } from "/sync/js/core/i18n.js";
import { escapeHtml } from "/sync/js/core/html.js";
import { renderClassIcon } from "/sync/js/sync/preview-renderer.js";
import { renderCharPendingLabel, renderCharPendingRow } from "/sync/js/sync/char-row.js";

const ICON_FOLDER = "\u{1F4C1}";
const ICON_DONE = "\u{1F7E2}";
const ICON_REJECTED = "\u26D4";

export function summarizeSyncResult(data = {}) {
  return {
    applied: asArray(data.applied).length,
    skipped: asArray(data.skipped).length,
    unmapped: asArray(data.unmapped).length,
    rejected: asArray(data.rejected).length,
  };
}

export function renderNoDeltaProfileStatsQueuedResult() {
  return `<div class="sync-result-summary">${t("sync.nothingToSync")}</div>${renderProfileStatsQueuedSection()}`;
}

export function renderSyncApplyResult(data = {}, rosterAccounts = []) {
  const counts = summarizeSyncResult(data);
  let html = `<div class="sync-result-summary"><span class="status-ok">${t("sync.complete")}</span> <span class="sync-summary-line">${t("sync.summary", {
    a: counts.applied,
    s: counts.skipped,
    u: counts.unmapped,
    r: counts.rejected,
  })}</span></div>`;

  const charLookup = buildRosterCharacterLookup(rosterAccounts);
  html += renderAppliedSection(asArray(data.applied), charLookup);
  html += renderRejectedSection(asArray(data.rejected), charLookup);
  html += renderUnmappedSection(asArray(data.unmapped));
  html += renderProfileStatsQueuedSection();
  return html;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function renderProfileStatsQueuedSection() {
  return `<div class="sync-result-section"><div class="sync-result-section-title">${escapeHtml(t("sync.profileStatsLabel"))}</div><div id="weekly-profile-sync-status"><span class="hint">${escapeHtml(t("sync.profileStatsQueued"))}</span></div></div>`;
}

function buildRosterCharacterLookup(rosterAccounts = []) {
  const charLookup = new Map();
  for (const acc of rosterAccounts || []) {
    for (const ch of (acc.characters || [])) {
      if (!ch?.name) continue;
      charLookup.set(String(ch.name).toLowerCase(), {
        accountName: acc.accountName || "",
        className: ch.class || "",
        itemLevel: Number(ch.itemLevel) || 0,
      });
    }
  }
  return charLookup;
}

function renderAppliedSection(applied, charLookup) {
  if (!applied.length) return "";
  const byRoster = groupAppliedByRoster(applied, charLookup);
  let html = `<div class="sync-result-section"><div class="sync-result-section-title">${escapeHtml(t("sync.appliedLabel"))}</div>`;
  for (const [accountName, charsMap] of byRoster) {
    html += renderRosterHeader(accountName);
    html += `<ul class="char-pending-list">`;
    for (const c of charsMap.values()) {
      const classIcon = renderClassIcon(c.className);
      const charLabel = renderCharPendingLabel(classIcon, c);
      const pillsHtml = c.applied.map(renderAppliedRaidPill).join("");
      html += renderCharPendingRow(charLabel, pillsHtml);
    }
    html += `</ul>`;
  }
  return `${html}</div>`;
}

function groupAppliedByRoster(applied, charLookup) {
  const byRoster = new Map();
  for (const entry of applied) {
    const info = charLookup.get(String(entry.charName || "").toLowerCase()) || {};
    const accountName = info.accountName || "";
    if (!byRoster.has(accountName)) byRoster.set(accountName, new Map());

    const charsMap = byRoster.get(accountName);
    const charKey = String(entry.charName || "").toLowerCase();
    if (!charsMap.has(charKey)) {
      charsMap.set(charKey, {
        charName: entry.charName,
        className: info.className || "",
        itemLevel: info.itemLevel || 0,
        applied: [],
      });
    }
    charsMap.get(charKey).applied.push(entry);
  }
  return byRoster;
}

function renderAppliedRaidPill(entry) {
  const raidLabel = getRaidLabel(entry.raidKey);
  const modeLabel = getModeLabel(entry.modeKey);
  const gateText = (entry.gates || []).join("+");
  return `<span class="raid-pill raid-pill--done">${ICON_DONE} ${escapeHtml(raidLabel)} <span class="raid-pill-mode">${escapeHtml(modeLabel)} ${escapeHtml(gateText)}</span></span>`;
}

function renderRejectedSection(rejected, charLookup) {
  if (!rejected.length) return "";
  let html = `<div class="sync-result-section"><div class="sync-result-section-title">${escapeHtml(t("sync.rejectedLabel"))}</div><ul class="char-pending-list">`;
  for (const entry of rejected) {
    const info = charLookup.get(String(entry.charName || "").toLowerCase()) || {};
    const classIcon = renderClassIcon(info.className);
    const charLabel = renderCharPendingLabel(classIcon, entry, { withItemLevel: false });
    const reasonText = entry.error ? `${entry.reason} (${entry.error})` : entry.reason;
    const pill = `<span class="raid-pill raid-pill--rejected">${ICON_REJECTED} ${escapeHtml(reasonText)}</span>`;
    html += renderCharPendingRow(charLabel, pill);
  }
  return `${html}</ul></div>`;
}

function renderUnmappedSection(unmapped) {
  if (!unmapped.length) return "";
  const bosses = unmapped.slice(0, 5).map((entry) => escapeHtml(entry.boss)).join(", ");
  const more = unmapped.length > 5 ? `, ${t("sync.unmappedMore", { n: unmapped.length - 5 })}` : "";
  return `<div class="sync-result-section sync-result-unmapped"><span class="hint">${t("sync.unmappedHint")} ${bosses}${more}</span></div>`;
}

function renderRosterHeader(accountName) {
  if (!accountName) return "";
  return `<div class="char-pending-roster-header">${ICON_FOLDER} <strong>${escapeHtml(accountName)}</strong></div>`;
}
