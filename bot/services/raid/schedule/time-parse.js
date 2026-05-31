/**
 * services/raid/schedule/time-parse.js
 * Parse a lead's start-time input into an absolute UTC Date. Forgiving on
 * purpose - leads kept getting bitten by a strict parser and having to retype
 * from scratch. Accepts:
 *   - relative "+Nh" / "+Nm" (timezone-independent, space-tolerant)
 *   - clock "20:00", VN "20h" / "21h30" / "21g30", dot "20.30", bare hour "20",
 *     HHMM digits "2000" / "830", and explicit 12h "8pm" / "8:30 pm"
 * Absolute forms are interpreted in the lead's language timezone (see
 * /raid-language -> artist-clock.getLangTzOffsetMinutes) and resolve to the
 * next occurrence. AM/PM is honored only when typed - a bare number is never
 * guessed into PM, so "8" stays 08:00 (predictable). Returns null on
 * unparseable input so the caller can show an example. Fixed-offset (no DST).
 */

"use strict";

const { getLangTzOffsetMinutes } = require("../../../utils/raid/schedule/artist-clock");

// "+2h" / "+90m" (whitespace already stripped before matching).
const RELATIVE_RE = /^\+(\d{1,4})(h|m)$/;
// hour + optional minutes (sep `:` `h` `g` `.`) + optional trailing `h`/`g` +
// optional am/pm. Matches "20:00", "20h", "21h30", "21g", "20.30", "8pm".
const CLOCK_RE = /^(\d{1,2})(?:[:hg.](\d{2}))?[hg]?(am|pm|a|p)?$/;
// 3-4 bare digits read as H:MM / HH:MM ("830" -> 8:30, "2000" -> 20:00).
const DIGITS_RE = /^(\d{3,4})$/;

// Resolve an (hh, mm) wall-clock in the lead's tz to the next future UTC instant.
function resolveClock(hh, mm, lang, now) {
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

// Apply an explicit am/pm marker to a 12-hour clock hour. Returns null when
// the hour is out of the 1-12 range a meridiem implies (e.g. "20pm").
function applyMeridiem(hh, marker) {
  if (!marker) return hh;
  if (hh < 1 || hh > 12) return null;
  const pm = marker[0] === "p";
  if (pm) return hh === 12 ? 12 : hh + 12;
  return hh === 12 ? 0 : hh; // am
}

/**
 * Parse a start-time string to an absolute UTC Date.
 * @param {string} input - e.g. "+2h", "+90m", "20:00", "20h", "21h30", "21g",
 *   "20.30", "20", "2000", "830", "8pm", "8:30 pm"
 * @param {string} lang - lead language code (vi/jp/en) for the wall-clock tz
 * @param {Date} [now=new Date()] - clock anchor (injectable for tests)
 * @returns {Date|null} absolute instant, or null when unparseable
 */
function parseStartTime(input, lang, now = new Date()) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;
  // Collapse all internal whitespace so "+ 2h", "8 pm", "20 : 00" all match.
  const compact = raw.replace(/\s+/g, "");

  const rel = RELATIVE_RE.exec(compact);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = rel[2] === "h" ? n * 3600000 : n * 60000;
    return new Date(now.getTime() + ms);
  }

  const digits = DIGITS_RE.exec(compact);
  if (digits) {
    const d = digits[1];
    const hh = Number(d.length === 3 ? d.slice(0, 1) : d.slice(0, 2));
    const mm = Number(d.slice(-2));
    return resolveClock(hh, mm, lang, now);
  }

  const clock = CLOCK_RE.exec(compact);
  if (clock) {
    const mm = clock[2] != null ? Number(clock[2]) : 0;
    const hh = applyMeridiem(Number(clock[1]), clock[3]);
    if (hh == null) return null;
    return resolveClock(hh, mm, lang, now);
  }

  return null;
}

module.exports = { parseStartTime };
