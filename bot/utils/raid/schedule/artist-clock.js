"use strict";

const ARTIST_QUIET_START_HOUR_VN = 3;
const ARTIST_QUIET_END_HOUR_VN = 8;

// Per-language tz offset (minutes from UTC) for persona-event schedulers:
// artist-bedtime fires at 3am LOCAL, artist-wakeup at 8am LOCAL.
const LANG_TZ_OFFSET_MINUTES = {
  vi: 7 * 60,
  jp: 9 * 60,
  en: 0,
};

function getLangTzOffsetMinutes(lang) {
  return LANG_TZ_OFFSET_MINUTES[lang] ?? LANG_TZ_OFFSET_MINUTES.vi;
}

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

function isInArtistQuietHoursForLang(now = new Date(), lang) {
  const hour = getCurrentHourForLang(now, lang);
  return hour >= ARTIST_QUIET_START_HOUR_VN && hour < ARTIST_QUIET_END_HOUR_VN;
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
  isInArtistQuietHours,
  isInArtistQuietHoursForLang,
  hasReachedArtistWakeupBoundary,
  hasReachedArtistWakeupBoundaryForLang,
};
