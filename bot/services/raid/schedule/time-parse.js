/**
 * services/raid/schedule/time-parse.js
 * Parse a lead's start-time input into an absolute UTC Date. Two forms:
 * relative "+Nh"/"+Nm" (timezone-independent) and absolute "HH:MM"
 * interpreted in the lead's language timezone (see /raid-language ->
 * artist-clock.getLangTzOffsetMinutes), resolving to the next occurrence.
 * Returns null on unparseable input so the caller can show an example.
 * Fixed-offset model (no DST), consistent with artist-clock.
 */

"use strict";

const { getLangTzOffsetMinutes } = require("../../../utils/raid/schedule/artist-clock");

const RELATIVE_RE = /^\+(\d{1,4})(h|m)$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * Parse a start-time string to an absolute UTC Date.
 * @param {string} input - "+2h" / "+90m" / "20:00"
 * @param {string} lang - lead language code (vi/jp/en) for the HH:MM timezone
 * @param {Date} [now=new Date()] - clock anchor (injectable for tests)
 * @returns {Date|null} absolute instant, or null when unparseable
 */
function parseStartTime(input, lang, now = new Date()) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;

  const rel = RELATIVE_RE.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = rel[2] === "h" ? n * 3600000 : n * 60000;
    return new Date(now.getTime() + ms);
  }

  const clock = CLOCK_RE.exec(raw);
  if (clock) {
    const hh = Number(clock[1]);
    const mm = Number(clock[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    const offsetMs = getLangTzOffsetMinutes(lang) * 60000;
    // Shift `now` into the lead's local wall clock so its UTC fields read as local.
    const localNow = new Date(now.getTime() + offsetMs);
    let targetLocalMs = Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate(),
      hh,
      mm,
      0,
      0
    );
    // Same-day slot already passed -> use the next day's occurrence.
    if (targetLocalMs <= localNow.getTime()) targetLocalMs += 24 * 3600000;
    return new Date(targetLocalMs - offsetMs);
  }

  return null;
}

module.exports = { parseStartTime };
