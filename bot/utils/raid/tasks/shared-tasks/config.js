"use strict";

// NA worlds run on "NA East timing" (region merge, 2025-10-21). Events are
// modelled on US Eastern wall-clock time, so they move with daylight saving
// (UTC-4 in summer, UTC-5 in winter) while the daily reset stays 10:00 UTC.
const SCHEDULE_SOURCE_TIME_ZONE = "America/New_York";
const SCHEDULE_SOURCE_LABEL = "ET";
const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";
const SHARED_TASK_CAP_DAILY = 5;
const SHARED_TASK_CAP_WEEKLY = 5;
const SHARED_TASK_CAP_SCHEDULED = 5;

const SCHEDULED_RESET = "scheduled";

// Null prototype: preset keys arrive as typed autocomplete text, and a plain
// object would answer "constructor" with an inherited member.
const SHARED_TASK_PRESETS = Object.freeze(Object.assign(Object.create(null), {
  custom: Object.freeze({
    preset: "custom",
    label: "Custom shared task",
    defaultName: "Shared Task",
    reset: "weekly",
    kind: "manual",
    emoji: "📝",
  }),
  event_shop: Object.freeze({
    preset: "event_shop",
    label: "Event Shop",
    defaultName: "Event Shop",
    reset: "weekly",
    kind: "manual",
    emoji: "🛒",
  }),
  chaos_gate: Object.freeze({
    preset: "chaos_gate",
    label: "Chaos Gate",
    defaultName: "Chaos Gate",
    reset: SCHEDULED_RESET,
    kind: "scheduled",
    emoji: "🌪️",
    timeZone: SCHEDULE_SOURCE_TIME_ZONE,
    activeDays: [1, 4, 6, 0],
    startMinute: 11 * 60,
    slotMinutes: 60,
    endMinuteExclusive: 6 * 60,
    scheduleText: "Mon/Thu/Sat/Sun hourly 11 AM-5 AM ET",
  }),
  field_boss: Object.freeze({
    preset: "field_boss",
    label: "Field Boss",
    defaultName: "Field Boss",
    reset: SCHEDULED_RESET,
    kind: "scheduled",
    emoji: "👹",
    timeZone: SCHEDULE_SOURCE_TIME_ZONE,
    activeDays: [2, 5, 0],
    startMinute: 11 * 60,
    slotMinutes: 60,
    endMinuteExclusive: 6 * 60,
    scheduleText: "Tue/Fri/Sun hourly 11 AM-5 AM ET",
  }),
}));

function getSharedTaskPreset(preset) {
  return SHARED_TASK_PRESETS[preset] || SHARED_TASK_PRESETS.custom;
}

module.exports = {
  SCHEDULE_SOURCE_TIME_ZONE,
  SCHEDULE_SOURCE_LABEL,
  VIETNAM_TIME_ZONE,
  SCHEDULED_RESET,
  SHARED_TASK_PRESETS,
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_SCHEDULED,
  getSharedTaskPreset,
};
