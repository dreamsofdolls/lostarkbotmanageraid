"use strict";

const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const SHARED_TASK_CAP_DAILY = 5;
const SHARED_TASK_CAP_WEEKLY = 5;
const SHARED_TASK_CAP_SCHEDULED = 5;

const SCHEDULED_RESET = "scheduled";

const SHARED_TASK_PRESETS = Object.freeze({
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
    timeZone: PACIFIC_TIME_ZONE,
    activeDays: [1, 4, 6, 0],
    startMinute: 11 * 60,
    endMinuteExclusive: 6 * 60,
    scheduleText: "Mon/Thu/Sat/Sun · 11 AM-5 AM PT",
  }),
  field_boss: Object.freeze({
    preset: "field_boss",
    label: "Field Boss",
    defaultName: "Field Boss",
    reset: SCHEDULED_RESET,
    kind: "scheduled",
    emoji: "👹",
    timeZone: PACIFIC_TIME_ZONE,
    activeDays: [2, 5, 0],
    startMinute: 11 * 60,
    endMinuteExclusive: 6 * 60,
    scheduleText: "Tue/Fri/Sun · 11 AM-5 AM PT",
  }),
});

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function getSharedTaskPreset(preset) {
  return SHARED_TASK_PRESETS[preset] || SHARED_TASK_PRESETS.custom;
}

function ensureSharedTasks(account) {
  if (!account || typeof account !== "object") return [];
  if (!Array.isArray(account.sharedTasks)) account.sharedTasks = [];
  return account.sharedTasks;
}

function countSharedTasksByReset(sharedTasks, reset, nowMs = Date.now()) {
  return (Array.isArray(sharedTasks) ? sharedTasks : []).filter(
    (task) =>
      task?.reset === reset &&
      !isSharedTaskArchived(task) &&
      !isSharedTaskExpired(task, nowMs)
  ).length;
}

function sharedTaskCapForReset(reset) {
  if (reset === "daily") return SHARED_TASK_CAP_DAILY;
  if (reset === "weekly") return SHARED_TASK_CAP_WEEKLY;
  return SHARED_TASK_CAP_SCHEDULED;
}

function parseSharedTaskExpiresAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return NaN;
  }
  return ms;
}

function isSharedTaskArchived(task) {
  return Number(task?.archivedAt) > 0;
}

function isSharedTaskExpired(task, nowMs = Date.now()) {
  const expiresAt = Number(task?.expiresAt) || 0;
  return expiresAt > 0 && expiresAt < nowMs;
}

function getVisibleSharedTasks(account, nowMs = Date.now()) {
  return ensureSharedTasks(account).filter(
    (task) =>
      task?.taskId &&
      !isSharedTaskArchived(task) &&
      !isSharedTaskExpired(task, nowMs)
  );
}

function getZonedParts(date = new Date(), timeZone = PACIFIC_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekday = WEEKDAY_SHORT.indexOf(byType.weekday);
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    weekday: weekday === -1 ? 0 : weekday,
    hour: Number(byType.hour),
    minute: Number(byType.minute),
  };
}

function shiftLocalDate(parts, deltaDays) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function localDateKey(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function scheduledTaskKey(task, anchorParts) {
  const preset = getSharedTaskPreset(task?.preset);
  return `${preset.preset}:${localDateKey(anchorParts)}`;
}

function resolveScheduledSharedTaskState(task, now = new Date()) {
  const preset = getSharedTaskPreset(task?.preset);
  if (preset.kind !== "scheduled") {
    return {
      active: false,
      key: null,
      scheduleText: preset.scheduleText || task?.reset || "manual",
      nextLabel: "",
    };
  }

  const parts = getZonedParts(now, preset.timeZone);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const activeToday =
    preset.activeDays.includes(parts.weekday) &&
    minuteOfDay >= preset.startMinute;
  const yesterday = shiftLocalDate(parts, -1);
  const activeFromYesterday =
    preset.activeDays.includes(yesterday.weekday) &&
    minuteOfDay < preset.endMinuteExclusive;

  const anchor = activeToday ? parts : activeFromYesterday ? yesterday : null;
  const active = !!anchor;
  const key = active ? scheduledTaskKey(task, anchor) : null;
  const completed = active && task?.completedForKey === key;

  let nextLabel = "";
  if (!active) {
    let next = null;
    if (
      preset.activeDays.includes(parts.weekday) &&
      minuteOfDay < preset.startMinute
    ) {
      next = parts;
    } else {
      for (let delta = 1; delta <= 7; delta += 1) {
        const candidate = shiftLocalDate(parts, delta);
        if (preset.activeDays.includes(candidate.weekday)) {
          next = candidate;
          break;
        }
      }
    }
    if (next) {
      nextLabel = `${WEEKDAY_SHORT[next.weekday]} 11:00 AM PT`;
    }
  }

  return {
    active,
    key,
    completed,
    anchorDateKey: anchor ? localDateKey(anchor) : "",
    scheduleText: preset.scheduleText,
    nextLabel,
  };
}

function isSharedTaskCompleted(task, now = new Date()) {
  if (task?.reset === SCHEDULED_RESET) {
    return resolveScheduledSharedTaskState(task, now).completed;
  }
  return !!task?.completed;
}

function getSharedTaskDisplay(task, now = new Date()) {
  const preset = getSharedTaskPreset(task?.preset);
  const name = String(task?.name || preset.defaultName).trim();
  if (task?.reset === SCHEDULED_RESET) {
    const state = resolveScheduledSharedTaskState(task, now);
    return {
      name,
      emoji: preset.emoji,
      completed: state.completed,
      status: state.active
        ? "đang mở"
        : state.nextLabel
          ? `next ${state.nextLabel}`
          : preset.scheduleText,
      scheduleText: preset.scheduleText,
      active: state.active,
      key: state.key,
    };
  }
  return {
    name,
    emoji: preset.emoji,
    completed: !!task?.completed,
    status: task?.reset || "weekly",
    scheduleText: task?.reset || "weekly",
    active: true,
    key: null,
  };
}

module.exports = {
  PACIFIC_TIME_ZONE,
  SCHEDULED_RESET,
  SHARED_TASK_PRESETS,
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_SCHEDULED,
  getSharedTaskPreset,
  ensureSharedTasks,
  countSharedTasksByReset,
  sharedTaskCapForReset,
  parseSharedTaskExpiresAt,
  isSharedTaskExpired,
  getVisibleSharedTasks,
  resolveScheduledSharedTaskState,
  isSharedTaskCompleted,
  getSharedTaskDisplay,
  normalizeName,
};
