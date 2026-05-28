/**
 * utils/raid/schedule/reset-windows.js
 * Daily reset boundary helper. LA VN daily reset is fixed at 17:00 VN
 * (= 10:00 UTC) - the boundary the rest of the codebase pivots on for
 * "what daily counts as today" decisions.
 */

"use strict";

/**
 * Start of the current daily-reset window in UTC ms. Returns today's
 * 10:00 UTC if `now` is already past it, otherwise yesterday's 10:00.
 * @param {Date|number} [now=new Date()] - test clock
 * @returns {number} window-start UTC ms
 */
function dailyResetStartMs(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const boundaryMs = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    10,
    0,
    0,
    0
  );
  return date.getTime() >= boundaryMs
    ? boundaryMs
    : boundaryMs - 24 * 60 * 60 * 1000;
}

module.exports = {
  dailyResetStartMs,
};
