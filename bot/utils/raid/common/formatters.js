/**
 * utils/raid/common/formatters.js
 * Shared display formatters for character labels, raid progress rollups,
 * Bible auto-sync freshness lines, and formatted gold totals.
 */

"use strict";

const { t } = require("../../../services/i18n");
const { getClassEmoji } = require("../../../models/Class");

/**
 * A character name as notices show it: the class icon, then the name in
 * bold. A class with no emoji (unknown, or not bootstrapped yet) leaves the
 * bare bold name, as `/raid-status` does.
 * @param {string} name
 * @param {string} [className]
 * @param {(className: string) => string} [lookup] - icon lookup for callers
 *   that inject one; defaults to the bootstrapped class emojis
 * @returns {string}
 */
function formatCharacterLabel(name, className, lookup = getClassEmoji) {
  const icon = className ? lookup(className) : "";
  return icon ? `${icon} **${name}**` : `**${name}**`;
}

/**
 * Render the shared `🟢 N done · 🟡 N partial · ⚪ N pending [· 🔒 N not eligible]`
 * footer line used by `/raid-status` (caller's own roster rollup) and
 * `/raid-check` (subject-scoped or filtered roster rollup). Caller owns
 * the aggregation upstream - this just formats the icon line so the two
 * surfaces can't drift on icon ordering / spacing / "not eligible"
 * suffix rules.
 *
 * `notEligible` is optional: omit / pass 0 to suppress the lock segment
 * (raid-status doesn't track it; raid-check does for chars below the
 * raid floor).
 */
function formatProgressTotals(totals, UI, lang) {
  // Default lang back-compat: omit `lang` and t() falls back to vi via the
  // resolver.
  const done = Number(totals?.done) || 0;
  const partial = Number(totals?.partial) || 0;
  const pending = Number(totals?.pending) || 0;
  const notEligible = Number(totals?.notEligible) || 0;
  const parts = [
    `${UI.icons.done} ${done} ${t("common.progress.done", lang)}`,
    `${UI.icons.partial} ${partial} ${t("common.progress.partial", lang)}`,
    `${UI.icons.pending} ${pending} ${t("common.progress.pending", lang)}`,
  ];
  if (notEligible > 0) {
    parts.push(`${UI.icons.lock} ${notEligible} ${t("common.progress.notEligible", lang)}`);
  }
  return parts.join(" · ");
}

/**
 * Render the Bible auto-sync freshness line /raid-status shows:
 * `🔄 Last synced ... · ⏳ Sync ready ...`. Callers decide when the next sync
 * opens, so each keeps its own cooldown source.
 * @param {object} state
 * @param {number} state.lastSyncAt - last successful sync in ms, 0 when never
 * @param {number} state.readyAt - when the next sync opens in ms, 0 when open now
 * @param {object} UI - shared icon palette
 * @param {string} lang - locale
 * @returns {string} the freshness line
 */
function formatAutoManageFreshnessLine({ lastSyncAt, readyAt }, UI, lang) {
  const lastSync = lastSyncAt > 0
    ? `${UI.icons.reset} ${t("raid-status.freshness.lastSynced", lang)} <t:${Math.floor(lastSyncAt / 1000)}:R>`
    : `${UI.icons.reset} ${t("raid-status.freshness.neverSynced", lang)}`;
  if (readyAt <= 0) {
    return `${lastSync} · ✅ ${t("raid-status.freshness.syncReadyNow", lang)}`;
  }
  return `${lastSync} · ⏳ ${t("raid-status.freshness.syncReady", lang)} <t:${Math.floor(readyAt / 1000)}:R>`;
}

/**
 * Render a gold amount with locale-style thousands separators and a
 * trailing `G` suffix (e.g. `26,000G`). Used by the per-character gold
 * line in `/raid-status` and the account / cross-account rollup. Negative
 * inputs (shouldn't occur in normal flow) and non-finite values floor to
 * `0G` rather than printing `NaN` so a render bug can't crash the embed.
 */
function formatGold(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "0G";
  return `${Math.floor(n).toLocaleString("en-US")}G`;
}

module.exports = {
  formatCharacterLabel,
  formatProgressTotals,
  formatAutoManageFreshnessLine,
  formatGold,
};
