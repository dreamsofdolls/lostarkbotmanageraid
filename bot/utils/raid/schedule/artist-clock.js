/**
 * utils/raid/schedule/artist-clock.js
 * Time-zone helpers for scheduled bedtime and wake-up announcements.
 * The quiet-hours window suppresses cleanup sweeps and 30-minute notices.
 * The *ForLang variants resolve boundaries in the configured locale's time
 * zone (Vietnam by default; Japanese and English guilds may differ).
 */

"use strict";

const ARTIST_QUIET_START_HOUR_VN = 3;
const ARTIST_QUIET_END_HOUR_VN = 8;

// Per-locale offset from UTC, in minutes, for bedtime and wake-up schedulers.
// Bedtime fires at 03:00 local time and wake-up fires at 08:00 local time.
const LANG_TZ_OFFSET_MINUTES = {
  vi: 7 * 60,
  jp: 9 * 60,
  en: 0,
};

function getLangTzOffsetMinutes(lang) {
  return LANG_TZ_OFFSET_MINUTES[lang] ?? LANG_TZ_OFFSET_MINUTES.vi;
}

/**
 * VN-local slot key for cleanup-tick dedup. Rounds down to :00 or :30.
 * Format: "YYYY-MM-DDTHH:MM" with MM ∈ {"00", "30"}.
 * @param {Date} [now=new Date()] - test clock
 * @returns {string} dedup key safe to store in GuildConfig.lastAutoCleanupKey
 */
function getTargetCleanupSlotKey(now = new Date()) {
  const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const dateHour = vnTime.toISOString().slice(0, 13);
  const slotMinute = vnTime.getUTCMinutes() < 30 ? "00" : "30";
  return `${dateHour}:${slotMinute}`;
}

function getTargetVNDayKey(now = new Date()) {
  return getTargetDayKeyForLang(now, "vi");
}

function getTargetDayKeyForLang(now = new Date(), lang) {
  const offsetMs = getLangTzOffsetMinutes(lang) * 60 * 1000;
  const localTime = new Date(now.getTime() + offsetMs);
  return localTime.toISOString().slice(0, 10);
}

function getCurrentVNHour(now = new Date()) {
  return getCurrentHourForLang(now, "vi");
}

function getCurrentHourForLang(now = new Date(), lang) {
  const offsetMs = getLangTzOffsetMinutes(lang) * 60 * 1000;
  const localTime = new Date(now.getTime() + offsetMs);
  return localTime.getUTCHours();
}

function isInArtistQuietHours(now = new Date()) {
  return isInArtistQuietHoursForLang(now, "vi");
}

/**
 * Whether `now` falls inside the configured quiet-hours window in the viewer's
 * local time. Quiet-hours suppress cleanup sweeps + 30-min notices so
 * the channel stays silent overnight (3am-8am local).
 * @param {Date} [now=new Date()] - test clock
 * @param {string} lang - viewer language (drives tz offset)
 * @returns {boolean}
 */
function isInArtistQuietHoursForLang(now = new Date(), lang) {
  const hour = getCurrentHourForLang(now, lang);
  return hour >= ARTIST_QUIET_START_HOUR_VN && hour < ARTIST_QUIET_END_HOUR_VN;
}

/**
 * Plain-text "DD/MM HH:mm" of an instant in the viewer's language tz. For
 * select-option descriptions, where Discord does not render `<t:..>` markup.
 * Uses the same fixed local format that parseStartTime accepts as input.
 * @param {Date|number|string} date - the instant (UTC)
 * @param {string} lang - viewer language (drives the tz offset)
 * @returns {string} e.g. "03/06 21:00"
 */
function formatStartShortForLang(date, lang) {
  const offsetMs = getLangTzOffsetMinutes(lang) * 60 * 1000;
  const local = new Date(new Date(date).getTime() + offsetMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

function hasReachedArtistWakeupBoundary(now = new Date()) {
  return hasReachedArtistWakeupBoundaryForLang(now, "vi");
}

function hasReachedArtistWakeupBoundaryForLang(now = new Date(), lang) {
  return getCurrentHourForLang(now, lang) >= ARTIST_QUIET_END_HOUR_VN;
}

module.exports = {
  ARTIST_QUIET_START_HOUR_VN,
  ARTIST_QUIET_END_HOUR_VN,
  getLangTzOffsetMinutes,
  getTargetCleanupSlotKey,
  getTargetVNDayKey,
  getTargetDayKeyForLang,
  getCurrentVNHour,
  getCurrentHourForLang,
  formatStartShortForLang,
  isInArtistQuietHours,
  isInArtistQuietHoursForLang,
  hasReachedArtistWakeupBoundary,
  hasReachedArtistWakeupBoundaryForLang,
};
