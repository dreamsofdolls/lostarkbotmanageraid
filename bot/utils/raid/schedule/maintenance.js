"use strict";

const { DEFAULT_LANGUAGE } = require("../../../locales");
const { lookupArray } = require("./locale-arrays");

// Lost Ark VN maintenance is fixed at Wednesday 14:00 VN. Keep this as a
// single schedule module so reminders, previews, and next-boundary math share
// the same source of truth.
const MAINTENANCE_DAY_VN = 3; // 0=Sun, 3=Wed
const MAINTENANCE_HOUR_VN = 14;
const MAINTENANCE_MINUTE_VN = 0;
const MAINTENANCE_TICK_MS = 60 * 1000;

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
    const isEarly = ["T-3h", "T-2h", "T-1h"].includes(slotKey);
    const ns = isEarly ? "maintenance-early" : "maintenance-countdown";
    return lookupArray(lang, `announcements.${ns}.${slotKey}`);
  }
  return [];
}

function getMaintenanceSlotForNow(now = new Date()) {
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const dayOfWeek = vn.getUTCDay();
  if (dayOfWeek !== MAINTENANCE_DAY_VN) return null;

  const hour = vn.getUTCHours();
  const minute = vn.getUTCMinutes();
  const minutesUntil =
    (MAINTENANCE_HOUR_VN - hour) * 60 + (MAINTENANCE_MINUTE_VN - minute);
  if (minutesUntil <= 0) return null;

  const earlyMatch = MAINTENANCE_EARLY_SLOTS.find(
    (slot) => slot.minutesBefore === minutesUntil
  );
  if (earlyMatch) {
    return { slot: earlyMatch, group: "early" };
  }

  const countdownMatch = MAINTENANCE_COUNTDOWN_SLOTS.find(
    (slot) => slot.minutesBefore === minutesUntil
  );
  if (countdownMatch) {
    return { slot: countdownMatch, group: "countdown" };
  }

  return null;
}

function pickMaintenanceVariant(slotKey, lang = DEFAULT_LANGUAGE) {
  const pool = lookupMaintenanceVariants(slotKey, lang);
  if (pool.length === 0) return "";
  return pool[Math.floor(Math.random() * pool.length)];
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

function getMaintenanceSlotConfigSnapshot() {
  return {
    dayOfWeek: MAINTENANCE_DAY_VN,
    utcHour: MAINTENANCE_HOUR_VN - 7,
    utcMinute: MAINTENANCE_MINUTE_VN,
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
  MAINTENANCE_DAY_VN,
  MAINTENANCE_HOUR_VN,
  MAINTENANCE_MINUTE_VN,
  MAINTENANCE_TICK_MS,
  MAINTENANCE_EARLY_SLOTS,
  MAINTENANCE_COUNTDOWN_SLOTS,
  lookupMaintenanceVariants,
  getMaintenanceSlotForNow,
  pickMaintenanceVariant,
  buildMaintenancePreview,
  getMaintenanceSlotConfigSnapshot,
  buildMaintenanceConfigQuery,
};
