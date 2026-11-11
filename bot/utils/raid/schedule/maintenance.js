/**
 * utils/raid/schedule/maintenance.js
 * Single source of truth for the Lost Ark weekly maintenance schedule
 * (Wednesday 00:00 Pacific time: 14:00 VN in US daylight time, 15:00 VN in
 * standard time). Slot config + reminder pool live here so reminders,
 * previews, and next-boundary math share one set of constants. NOTE:
 * maintenance is NOT the daily reset (17:00 VN, fixed in UTC) - don't
 * conflate the two.
 */

"use strict";

const { DEFAULT_LANGUAGE } = require("../../../locales");
const { lookupArray, pickArrayVariant } = require("./locale-arrays");
const {
  getZonedParts,
  shiftLocalDate,
  zonedDateTimeToUtcMs,
} = require("../tasks/shared-tasks/schedule");

// Official notices give the start as "12:00 AM PT", so it follows US daylight
// saving while the reset stays at 10:00 UTC.
const MAINTENANCE_TIME_ZONE = "America/Los_Angeles";
const MAINTENANCE_WEEKDAY = 3; // 0=Sun, 3=Wed, in MAINTENANCE_TIME_ZONE
const MAINTENANCE_HOUR = 0;
const MAINTENANCE_MINUTE = 0;
const MAINTENANCE_TICK_MS = 60 * 1000;
const MINUTE_MS = 60 * 1000;

const MAINTENANCE_TTL_EARLY_MS = 30 * 60 * 1000;
const MAINTENANCE_TTL_COUNTDOWN_MS = 10 * 60 * 1000;
const MAINTENANCE_TTL_FINAL_MS = 5 * 60 * 1000;

const MAINTENANCE_EARLY_SLOTS = [
  { key: "T-3h", minutesBefore: 180, ttlMs: MAINTENANCE_TTL_EARLY_MS, pingHere: true },
  { key: "T-2h", minutesBefore: 120, ttlMs: MAINTENANCE_TTL_EARLY_MS, pingHere: false },
  { key: "T-1h", minutesBefore: 60, ttlMs: MAINTENANCE_TTL_EARLY_MS, pingHere: true },
];

const MAINTENANCE_COUNTDOWN_SLOTS = [
  { key: "T-15m", minutesBefore: 15, ttlMs: MAINTENANCE_TTL_COUNTDOWN_MS, pingHere: false },
  { key: "T-10m", minutesBefore: 10, ttlMs: MAINTENANCE_TTL_COUNTDOWN_MS, pingHere: false },
  { key: "T-5m", minutesBefore: 5, ttlMs: MAINTENANCE_TTL_COUNTDOWN_MS, pingHere: false },
  { key: "T-1m", minutesBefore: 1, ttlMs: MAINTENANCE_TTL_FINAL_MS, pingHere: false },
];

function lookupMaintenanceVariants(slotKey, lang) {
  if (slotKey?.startsWith("T-") && /^T-\d+(?:h|m)$/.test(slotKey)) {
    const isEarly = MAINTENANCE_EARLY_SLOTS.some((slot) => slot.key === slotKey);
    const ns = isEarly ? "maintenance-early" : "maintenance-countdown";
    return lookupArray(lang, `announcements.${ns}.${slotKey}`);
  }
  return [];
}

/**
 * First maintenance start strictly after `after`, as UTC ms.
 * @param {Date|number} [after=new Date()] - reference instant
 * @returns {number} UTC ms of the next Wednesday 00:00 Pacific time
 */
function nextMaintenanceStartMs(after = new Date()) {
  const afterMs = after instanceof Date ? after.getTime() : Number(after);
  const today = getZonedParts(new Date(afterMs), MAINTENANCE_TIME_ZONE);
  // Days 0..7 cover today's start (if still ahead) and next week's.
  for (let delta = 0; delta <= 7; delta += 1) {
    const day = shiftLocalDate(today, delta);
    if (day.weekday !== MAINTENANCE_WEEKDAY) continue;
    const startMs = zonedDateTimeToUtcMs(day, MAINTENANCE_HOUR, MAINTENANCE_MINUTE, MAINTENANCE_TIME_ZONE);
    if (startMs > afterMs) return startMs;
  }
  return null;
}

/**
 * Resolve which maintenance reminder slot (if any) matches the current
 * minute. Returns the matching slot + group ("early" or "countdown") and the
 * maintenance start it counts down to, or null when off-cycle. Slot match is
 * exact-minute by design (seconds are ignored); the scheduler ticks every
 * minute.
 * @param {Date} [now=new Date()] - test clock
 * @returns {{slot: object, group: "early"|"countdown", startMs: number}|null}
 */
function getMaintenanceSlotForNow(now = new Date()) {
  const nowMinuteMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const startMs = nextMaintenanceStartMs(nowMinuteMs);
  const minutesUntil = (startMs - nowMinuteMs) / MINUTE_MS;

  const earlyMatch = MAINTENANCE_EARLY_SLOTS.find(
    (slot) => slot.minutesBefore === minutesUntil
  );
  if (earlyMatch) {
    return { slot: earlyMatch, group: "early", startMs };
  }

  const countdownMatch = MAINTENANCE_COUNTDOWN_SLOTS.find(
    (slot) => slot.minutesBefore === minutesUntil
  );
  if (countdownMatch) {
    return { slot: countdownMatch, group: "countdown", startMs };
  }

  return null;
}

/**
 * Random-pick a single message variant from the slot's variant pool.
 * @param {string} slotKey - one of T-3h/T-2h/T-1h/T-15m/T-10m/T-5m/T-1m
 * @param {string} [lang=DEFAULT_LANGUAGE] - viewer language for the pool lookup
 * @returns {string} chosen variant text, or "" when the pool is empty
 */
function pickMaintenanceVariant(slotKey, lang = DEFAULT_LANGUAGE) {
  return pickArrayVariant(lookupMaintenanceVariants(slotKey, lang));
}

function buildMaintenancePreview(group) {
  const slots = group === "early" ? MAINTENANCE_EARLY_SLOTS : MAINTENANCE_COUNTDOWN_SLOTS;
  const VARIANT_MAX = 70;
  const lines = [
    group === "early"
      ? "Random pick mỗi mốc (3 variants/mốc):"
      : "Random pick mỗi mốc (3 variants/mốc, đếm ngược):",
  ];

  for (const slot of slots) {
    const pool = lookupMaintenanceVariants(slot.key, DEFAULT_LANGUAGE);
    lines.push("");
    lines.push(`**${slot.key}**${slot.pingHere ? " (ping @here)" : ""} - ${pool.length} variants:`);
    for (const variant of pool) {
      const shortened =
        variant.length > VARIANT_MAX ? variant.slice(0, VARIANT_MAX) + "..." : variant;
      lines.push(`- ${shortened}`);
    }
  }

  return lines.join("\n");
}

/**
 * Snapshot of slot config for cross-module consumption (e.g.
 * scheduling.js `resolveMaintenanceSlotConfig` resolver). Consumers get the
 * start resolver instead of a fixed UTC hour, so daylight saving is handled
 * in one place.
 * @returns {{nextStartMs: function(Date|number): number, earlyMinutes: number[], countdownMinutes: number[]}}
 */
function getMaintenanceSlotConfigSnapshot() {
  return {
    nextStartMs: nextMaintenanceStartMs,
    earlyMinutes: MAINTENANCE_EARLY_SLOTS.map((slot) => slot.minutesBefore),
    countdownMinutes: MAINTENANCE_COUNTDOWN_SLOTS.map((slot) => slot.minutesBefore),
  };
}

function buildMaintenanceConfigQuery() {
  return {
    $or: [
      { raidChannelId: { $ne: null } },
      { "announcements.maintenanceEarly.channelId": { $ne: null } },
      { "announcements.maintenanceCountdown.channelId": { $ne: null } },
    ],
  };
}

module.exports = {
  MAINTENANCE_TIME_ZONE,
  MAINTENANCE_WEEKDAY,
  MAINTENANCE_HOUR,
  MAINTENANCE_MINUTE,
  MAINTENANCE_TICK_MS,
  nextMaintenanceStartMs,
  getMaintenanceSlotForNow,
  pickMaintenanceVariant,
  buildMaintenancePreview,
  getMaintenanceSlotConfigSnapshot,
  buildMaintenanceConfigQuery,
};
