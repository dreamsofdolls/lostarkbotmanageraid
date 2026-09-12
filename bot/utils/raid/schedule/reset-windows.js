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

/**
 * Start of the current weekly-reset window in UTC ms. Lost Ark resets on
 * Wednesday at 10:00 UTC; before that boundary the active window started on
 * the preceding Wednesday.
 * @param {Date|number} [now=new Date()] - test clock
 * @returns {number} window-start UTC ms
 */
function weeklyResetStartMs(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const cursor = new Date(date.getTime());
  for (let i = 0; i < 8; i += 1) {
    const day = cursor.getUTCDay();
    if (day === 3 && cursor.getUTCHours() >= 10) {
      return Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        10, 0, 0, 0
      );
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    cursor.setUTCHours(23, 59, 59, 999);
  }
  return date.getTime() - 7 * 24 * 60 * 60 * 1000;
}

/**
 * Decode the persisted ISO-week cursor to its Wednesday 10:00 UTC boundary.
 * Invalid or absent legacy keys return null so callers can keep their fallback.
 */
function weeklyResetStartFromKey(key) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(key || ""));
  if (!match) return null;
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  const january4 = new Date(`${match[1]}-01-04T10:00:00.000Z`);
  const isoDay = january4.getUTCDay() || 7;
  const start = january4.getTime() + (3 - isoDay + (week - 1) * 7) * 86400000;
  // Thursday determines the ISO year, rejecting W53 in a 52-week year.
  if (new Date(start + 86400000).getUTCFullYear() !== Number(match[1])) return null;
  return start;
}

module.exports = {
  dailyResetStartMs,
  weeklyResetStartMs,
  weeklyResetStartFromKey,
};
