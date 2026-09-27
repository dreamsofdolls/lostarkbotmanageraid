"use strict";

/**
 * bot/services/raid-log/parse-tiers.js
 * Percentile tiers in the colours Bible gives its badges (log zEn59i4:
 * 37 green, 59 and 63 blue, 76 to 91 purple, 97 orange, 99 pink).
 */

const PARSE_TIERS = Object.freeze([
  { min: 99, emoji: "🌸", color: 0xe268a8 },
  { min: 95, emoji: "🟠", color: 0xff8000 },
  { min: 75, emoji: "🟣", color: 0xa335ee },
  { min: 50, emoji: "🔵", color: 0x0070ff },
  { min: 25, emoji: "🟢", color: 0x1eff00 },
  { min: 0, emoji: "⚪", color: 0x9d9d9d },
]);
const NO_TIER = Object.freeze({ emoji: "⚪", color: null });

/**
 * @param {number|null} percent whole percent
 * @returns {{ emoji: string, color: number|null }} color is null without a value
 */
function parseTier(percent) {
  if (!Number.isFinite(percent)) return NO_TIER;
  return PARSE_TIERS.find(tier => percent >= tier.min) || NO_TIER;
}

module.exports = { parseTier };
