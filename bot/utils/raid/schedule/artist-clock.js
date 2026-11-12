/**
 * utils/raid/schedule/artist-clock.js
 * Artist's sleep window and the time-zone helpers built on it. The quiet
 * hours suppress cleanup sweeps and 30-minute notices; isDuringArtistSleep
 * is the check every scheduler asks before posting on its own. The *ForLang
 * variants resolve boundaries in the configured locale's time zone (Vietnam
 * by default; Japanese and English guilds may differ).
 */

"use strict";

const ARTIST_QUIET_START_HOUR_VN = 2;
const ARTIST_QUIET_END_HOUR_VN = 9;

// Per-locale offset from UTC, in minutes, for bedtime and wake-up schedulers.
// Bedtime fires at ARTIST_QUIET_START_HOUR_VN and wake-up at
// ARTIST_QUIET_END_HOUR_VN, both on the locale's clock.
const LANG_TZ_OFFSET_MINUTES = {
  vi: 7 * 60,
  jp: 9 * 60,
  en: 0,
};

function getLangTzOffsetMinutes(lang) {
  return LANG_TZ_OFFSET_MINUTES[lang] ?? LANG_TZ_OFFSET_MINUTES.vi;
}

/**
 * `now` moved by the locale's UTC offset, so its getUTC* fields and
 * toISOString() read that locale's wall clock.
 * @param {Date} now - the instant
 * @param {string} lang - locale code (unknown falls back to vi)
 * @returns {Date} shifted copy
 */
function toLocalClock(now, lang) {
  return new Date(now.getTime() + getLangTzOffsetMinutes(lang) * 60 * 1000);
}

/**
 * VN-local slot key for cleanup-tick dedup. Rounds down to :00 or :30.
 * Format: "YYYY-MM-DDTHH:MM" with MM ∈ {"00", "30"}.
 * @param {Date} [now=new Date()] - test clock
 * @returns {string} dedup key safe to store in GuildConfig.lastAutoCleanupKey
 */
function getTargetCleanupSlotKey(now = new Date()) {
  const vnTime = toLocalClock(now, "vi");
  const dateHour = vnTime.toISOString().slice(0, 13);
  const slotMinute = vnTime.getUTCMinutes() < 30 ? "00" : "30";
  return `${dateHour}:${slotMinute}`;
}

function getTargetVNDayKey(now = new Date()) {
  return getTargetDayKeyForLang(now, "vi");
}

function getTargetDayKeyForLang(now = new Date(), lang) {
  return toLocalClock(now, lang).toISOString().slice(0, 10);
}

function getCurrentVNHour(now = new Date()) {
  return getCurrentHourForLang(now, "vi");
}

function getCurrentHourForLang(now = new Date(), lang) {
  return toLocalClock(now, lang).getUTCHours();
}

function isInArtistQuietHours(now = new Date()) {
  return isInArtistQuietHoursForLang(now, "vi");
}

/**
 * Whether `now` falls inside the configured quiet-hours window in the viewer's
 * local time. Quiet-hours suppress cleanup sweeps + 30-min notices so
 * the channel stays silent overnight, from the bedtime hour through the
 * minute before the wake-up hour.
 * @param {Date} [now=new Date()] - test clock
 * @param {string} lang - viewer language (drives tz offset)
 * @returns {boolean}
 */
function isInArtistQuietHoursForLang(now = new Date(), lang) {
  const hour = getCurrentHourForLang(now, lang);
  return hour >= ARTIST_QUIET_START_HOUR_VN && hour < ARTIST_QUIET_END_HOUR_VN;
}

/**
 * Whether Artist is asleep at this moment on the guild language's clock, for
 * posts she would make on her own. The bedtime and wake-up minutes count as
 * awake, so an item at bedtime is her last post and one at wake-up her first.
 * @param {Date|number} instant - the moment the post is about: a spawn, a
 *   maintenance start, or the post itself
 * @param {string} lang - guild language (drives the tz offset)
 * @returns {boolean} true strictly between bedtime and wake-up
 */
function isDuringArtistSleep(instant, lang) {
  const local = toLocalClock(new Date(instant), lang);
  const minuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minuteOfDay > ARTIST_QUIET_START_HOUR_VN * 60
    && minuteOfDay < ARTIST_QUIET_END_HOUR_VN * 60;
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
  toLocalClock,
  getTargetCleanupSlotKey,
  getTargetVNDayKey,
  getTargetDayKeyForLang,
  getCurrentVNHour,
  isInArtistQuietHours,
  isInArtistQuietHoursForLang,
  isDuringArtistSleep,
  hasReachedArtistWakeupBoundary,
  hasReachedArtistWakeupBoundaryForLang,
};
