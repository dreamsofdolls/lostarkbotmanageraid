/**
 * services/raid/schedule/slot-config.js
 * Recommended Support/DPS slot split per party size. Soft guidance only -
 * the board does not hard-enforce roles, but these counts drive the
 * default comp shape (4-man = 1 sup + 3 dps, 8-man = 2 sup + 6 dps) and
 * the waitlist overflow boundary.
 */

"use strict";

/**
 * Recommended slot counts for a party size.
 * @param {number} size - party size, 4 or 8
 * @returns {{supSlots: number, dpsSlots: number}}
 * @throws {Error} when size is not 4 or 8
 */
function slotCountsForSize(size) {
  if (size === 4) return { supSlots: 1, dpsSlots: 3 };
  if (size === 8) return { supSlots: 2, dpsSlots: 6 };
  throw new Error(`[raid-schedule] unsupported party size: ${size}`);
}

module.exports = { slotCountsForSize };
