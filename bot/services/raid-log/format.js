"use strict";

/**
 * bot/services/raid-log/format.js
 * Number, percent and time formatting shared by the /raid-log cards. An
 * empty figure reads "-".
 */

const UNITS = [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]];
const WHEN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/**
 * @param {number|null|undefined} value
 * @returns {string} three significant digits with a K/M/B/T unit ("1.06B", "386M", "3.5K"); "-" without a value
 */
function formatCompact(value) {
  if (!Number.isFinite(value)) return "-";
  for (const [index, [unit, size]] of UNITS.entries()) {
    if (Math.abs(value) < size) continue;
    const scaled = value / size;
    const rounded = Number(scaled.toFixed(Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2));
    // 999.6M rounds to 1000M; the next unit up reads it as 1B.
    if (Math.abs(rounded) >= 1000 && index > 0) return formatCompact(rounded * size);
    return `${rounded}${unit}`;
  }
  return String(Math.round(value));
}

/**
 * @param {number|null|undefined} fraction Bible percentile (0.9925)
 * @returns {number|null} whole percent, floored as Bible's badges show it (99)
 */
function percentOf(fraction) {
  // The epsilon absorbs binary rounding: 0.29 * 100 is 28.999999999999996.
  return Number.isFinite(fraction) ? Math.floor(fraction * 100 + 1e-9) : null;
}

/**
 * @param {number|null} percent whole percent from percentOf
 * @returns {string} "99%", or "-" without a value
 */
function formatPercent(percent) {
  return percent === null ? "-" : `${percent}%`;
}

/**
 * @param {number|null|undefined} fraction a share such as rContribution (0.5259)
 * @returns {string} percent with one decimal ("52.6%"), or "-" without a value
 */
function formatShare(fraction) {
  return Number.isFinite(fraction) ? `${Number((fraction * 100).toFixed(1))}%` : "-";
}

/**
 * @param {number} ms
 * @returns {string} m:ss
 */
function formatClock(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * @param {number} timestamp epoch ms
 * @returns {string} dd/MM HH:mm in Vietnam time, as the panel has always shown
 */
function formatWhen(timestamp) {
  const parts = Object.fromEntries(WHEN.formatToParts(timestamp).map(part => [part.type, part.value]));
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}

module.exports = { formatCompact, percentOf, formatPercent, formatShare, formatClock, formatWhen };
