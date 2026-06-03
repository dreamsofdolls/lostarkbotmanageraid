/**
 * services/raid/schedule/time-parse.js
 * Parse a lead's start-time input into an absolute UTC Date. Forgiving on
 * purpose - leads kept getting bitten by a strict parser and having to retype
 * from scratch. Accepts:
 *   - relative "+Nh" / "+Nm" (timezone-independent, space-tolerant)
 *   - time-of-day "20:00", VN "20h" / "21h30" / "21g30", dot "20.30", bare "20",
 *     HHMM "2000" / "830", explicit 12h "8pm" / "8:30 pm" -> next occurrence
 *   - WEEKDAY + time "thứ 4 20:00" / "t4 20h" / "cn 8pm" / "wed 21h30" -> the next
 *     occurrence of that weekday at that time
 *   - DATE + time "5/6 20:00" / "05/06 20h" / "5/6/2026 8pm" -> that calendar date
 *     (this year, or next year if already past when no year given) at that time
 * Absolute forms are interpreted in the lead's language timezone (see
 * /raid-language -> artist-clock.getLangTzOffsetMinutes). A day-anchor (weekday
 * or date) MUST be followed by a time. AM/PM is honored only when typed. Returns
 * null on unparseable input. Fixed-offset (no DST).
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

// Day-anchor matchers. Each captures the weekday/date then the rest (= time).
// VN "thứ N" (N 2-7): thứ2=Monday ... thứ7=Saturday -> JS day = N-1. The \b after
// the digit stops "thu 20:00" (Thursday) being mis-read as "thứ 2" + "0:00".
const VN_THU_RE = /^th[uứ]\s*([2-7])\b\s*(.*)$/;
const VN_TSHORT_RE = /^t([2-7])\b\s*(.*)$/;
const VN_CN_RE = /^(?:cn|ch[uủ]\s*nh[aậ]t)\b\s*(.*)$/;
const EN_DOW_RE = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b\s*(.*)$/;
const EN_DOW = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
// "D/M" or "D/M/YY(YY)" followed by a time.
const DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(.+)$/;

// Parse just a time-of-day token (already space-collapsed) into {hh, mm}, or
// null. Shared by the time-only path and every day-anchor path.
function parseTimeOfDay(s) {
  let hh;
  let mm;
  const digits = DIGITS_RE.exec(s);
  if (digits) {
    const d = digits[1];
    hh = Number(d.length === 3 ? d.slice(0, 1) : d.slice(0, 2));
    mm = Number(d.slice(-2));
  } else {
    const clock = CLOCK_RE.exec(s);
    if (!clock) return null;
    mm = clock[2] != null ? Number(clock[2]) : 0;
    hh = applyMeridiem(Number(clock[1]), clock[3]);
    if (hh == null) return null;
  }
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
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

// Lead-tz local "now" as a Date whose UTC fields read as the lead's wall clock.
function localNowFor(lang, now) {
  return { offsetMs: getLangTzOffsetMinutes(lang) * 60000, local: new Date(now.getTime() + getLangTzOffsetMinutes(lang) * 60000) };
}

// Resolve an (hh, mm) wall-clock in the lead's tz to the next future UTC instant.
function resolveClock(hh, mm, lang, now) {
  const { offsetMs, local } = localNowFor(lang, now);
  let targetLocalMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm, 0, 0);
  if (targetLocalMs <= local.getTime()) targetLocalMs += 24 * 3600000; // already passed -> tomorrow
  return new Date(targetLocalMs - offsetMs);
}

// Resolve to the next occurrence of `dow` (JS 0=Sun..6=Sat) at hh:mm, lead tz.
function resolveOnWeekday(dow, hh, mm, lang, now) {
  const { offsetMs, local } = localNowFor(lang, now);
  let addDays = (dow - local.getUTCDay() + 7) % 7;
  let targetLocalMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays, hh, mm, 0, 0);
  // Today is the weekday but the slot already passed -> jump a week.
  if (addDays === 0 && targetLocalMs <= local.getTime()) targetLocalMs += 7 * 24 * 3600000;
  return new Date(targetLocalMs - offsetMs);
}

// Resolve to day/month(/year) at hh:mm in lead tz. No year -> this year, or next
// year if that instant already passed. Returns null for impossible dates (31/2).
function resolveOnDate(day, month, year, hh, mm, lang, now) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const { offsetMs, local } = localNowFor(lang, now);
  let yr = year == null ? local.getUTCFullYear() : year < 100 ? 2000 + year : year;
  let targetLocalMs = Date.UTC(yr, month - 1, day, hh, mm, 0, 0);
  const check = new Date(targetLocalMs);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null; // e.g. 31/2
  if (year == null && targetLocalMs <= local.getTime()) {
    targetLocalMs = Date.UTC(yr + 1, month - 1, day, hh, mm, 0, 0);
  }
  return new Date(targetLocalMs - offsetMs);
}

// Pull a leading weekday anchor off `raw`, returning { dow, rest } or null.
function matchWeekdayAnchor(raw) {
  let m = VN_THU_RE.exec(raw) || VN_TSHORT_RE.exec(raw);
  if (m) return { dow: (Number(m[1]) - 1 + 7) % 7, rest: m[2] }; // thứ2=Mon(1) .. thứ7=Sat(6)
  m = VN_CN_RE.exec(raw);
  if (m) return { dow: 0, rest: m[1] };
  m = EN_DOW_RE.exec(raw);
  if (m) return { dow: EN_DOW[m[1]], rest: m[2] };
  return null;
}

/**
 * Parse a start-time string to an absolute UTC Date.
 * @param {string} input - e.g. "+2h", "20:00", "20h", "8pm", "2000",
 *   "thứ 4 20:00", "t4 20h", "cn 8pm", "wed 21h30", "5/6 20:00", "5/6/2026 8pm"
 * @param {string} lang - lead language code (vi/jp/en) for the wall-clock tz
 * @param {Date} [now=new Date()] - clock anchor (injectable for tests)
 * @returns {Date|null} absolute instant, or null when unparseable
 */
function parseStartTime(input, lang, now = new Date()) {
  const raw = String(input || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw) return null;
  const compact = raw.replace(/ /g, "");

  const rel = RELATIVE_RE.exec(compact);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(now.getTime() + (rel[2] === "h" ? n * 3600000 : n * 60000));
  }

  // Day-anchored: weekday/date + a time. The anchor needs a time after it.
  const dateM = DATE_RE.exec(raw);
  if (dateM) {
    const time = parseTimeOfDay(dateM[4].replace(/\s+/g, ""));
    if (!time) return null;
    return resolveOnDate(Number(dateM[1]), Number(dateM[2]), dateM[3] != null ? Number(dateM[3]) : null, time.hh, time.mm, lang, now);
  }
  const wd = matchWeekdayAnchor(raw);
  if (wd) {
    const time = parseTimeOfDay(String(wd.rest).replace(/\s+/g, ""));
    if (!time) return null;
    return resolveOnWeekday(wd.dow, time.hh, time.mm, lang, now);
  }

  // Plain time-of-day -> next occurrence today/tomorrow.
  const time = parseTimeOfDay(compact);
  if (time) return resolveClock(time.hh, time.mm, lang, now);
  return null;
}

module.exports = { parseStartTime };
