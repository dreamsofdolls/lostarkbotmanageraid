import { escapeHtml } from "/sync/js/core/html.js";

/**
 * Build the char-label cell (class icon + bold name + optional item level)
 * shared by the sync preview + result renderers. Pass withItemLevel:false for
 * the compact rejected-row variant that omits the iLvl span.
 * @param {string} classIcon - pre-rendered class icon HTML (may be "")
 * @param {{charName?: string, itemLevel?: number|string}} char - char entry
 * @param {{withItemLevel?: boolean}} [opts]
 * @returns {string} the label inner-HTML
 */
export function renderCharPendingLabel(classIcon, char, { withItemLevel = true } = {}) {
  const itemLevel =
    withItemLevel && char.itemLevel
      ? ` <span class="stat-label">${char.itemLevel}</span>`
      : "";
  return `${classIcon}<strong>${escapeHtml(char.charName || "")}</strong>${itemLevel}`;
}

/**
 * Wrap a char label + a right-hand cell (raid pills / gold pill / status pill)
 * in the shared `<li class="char-pending-row">` scaffold so the row markup
 * lives in one place across both sync renderers.
 * @param {string} label - output of renderCharPendingLabel
 * @param {string} rightHtml - the right-cell inner HTML
 * @returns {string} the `<li>` row HTML
 */
export function renderCharPendingRow(label, rightHtml) {
  return `<li class="char-pending-row"><span class="char-pending-head">${label}</span><span class="raid-pill-row">${rightHtml}</span></li>`;
}
