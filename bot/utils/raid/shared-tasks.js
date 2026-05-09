"use strict";

const SCHEDULE_SOURCE_TIME_ZONE = "Etc/GMT+4"; // Fixed UTC-4; IANA Etc sign is intentionally reversed.
const SCHEDULE_SOURCE_LABEL = "UTC-4";
const PACIFIC_TIME_ZONE = SCHEDULE_SOURCE_TIME_ZONE; // Backward-compatible export name.
const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";
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
    timeZone: SCHEDULE_SOURCE_TIME_ZONE,
    activeDays: [1, 4, 6, 0],
    startMinute: 11 * 60,
    slotMinutes: 60,
    endMinuteExclusive: 6 * 60,
    scheduleText: "Mon/Thu/Sat/Sun hourly 11 AM-5 AM UTC-4",
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
    scheduleText: "Tue/Fri/Sun hourly 11 AM-5 AM UTC-4",
  }),
});

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_VN = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

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

function getZonedParts(date = new Date(), timeZone = SCHEDULE_SOURCE_TIME_ZONE) {
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

function zonedDateTimeToUtcMs(parts, hour, minute, timeZone = SCHEDULE_SOURCE_TIME_ZONE) {
  const targetWallMs = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute);
  let guessMs = targetWallMs;
  for (let i = 0; i < 4; i += 1) {
    const current = getZonedParts(new Date(guessMs), timeZone);
    const currentWallMs = Date.UTC(
      current.year,
      current.month - 1,
      current.day,
      current.hour,
      current.minute
    );
    const deltaMs = currentWallMs - targetWallMs;
    if (deltaMs === 0) break;
    guessMs -= deltaMs;
  }
  return guessMs;
}

function formatDiscordTimestamp(ms, style = "f") {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  return `<t:${Math.floor(value / 1000)}:${style}>`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatTwelveHour(parts) {
  const hour = parts.hour % 12 || 12;
  const suffix = parts.hour < 12 ? "AM" : "PM";
  return `${hour}:${pad2(parts.minute)} ${suffix}`;
}

function formatVietnamSourceScheduleLabel(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const vn = getZonedParts(date, VIETNAM_TIME_ZONE);
  const source = getZonedParts(date, SCHEDULE_SOURCE_TIME_ZONE);
  return [
    `${WEEKDAY_VN[vn.weekday]} ${pad2(vn.hour)}:${pad2(vn.minute)} VN`,
    `${WEEKDAY_SHORT[source.weekday]} ${formatTwelveHour(source)} ${SCHEDULE_SOURCE_LABEL}`,
  ].join(" · ");
}

function formatVietnamScheduleLabel(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const vn = getZonedParts(new Date(value), VIETNAM_TIME_ZONE);
  return `${WEEKDAY_VN[vn.weekday]} ${pad2(vn.hour)}:${pad2(vn.minute)} VN`;
}

function localDateKey(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function utcDateKey(date) {
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join("-");
}

function dailyResetStartMs(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const boundaryMs = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    10,
    0,
    0,
    0
  );
  return date.getTime() >= boundaryMs
    ? boundaryMs
    : boundaryMs - 24 * 60 * 60 * 1000;
}

function scheduledTaskKey(task, slotStartAtMs) {
  const preset = getSharedTaskPreset(task?.preset);
  const slotStart = new Date(slotStartAtMs);
  const slotTime = `${pad2(slotStart.getUTCHours())}:${pad2(slotStart.getUTCMinutes())}`;
  return `${preset.preset}:slot:${utcDateKey(slotStart)}T${slotTime}Z`;
}

function scheduleWindowDurationMinutes(preset) {
  if (preset.endMinuteExclusive > preset.startMinute) {
    return preset.endMinuteExclusive - preset.startMinute;
  }
  return 24 * 60 - preset.startMinute + preset.endMinuteExclusive;
}

function getScheduleSlotMinutes(preset) {
  const value = Number(preset.slotMinutes);
  return Number.isFinite(value) && value > 0
    ? value
    : scheduleWindowDurationMinutes(preset);
}

function utcMsFromAnchorRelativeMinute(anchorParts, relativeMinute, timeZone) {
  const dayOffset = Math.floor(relativeMinute / (24 * 60));
  const minuteOfDay = relativeMinute % (24 * 60);
  const parts = shiftLocalDate(anchorParts, dayOffset);
  return zonedDateTimeToUtcMs(
    parts,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    timeZone
  );
}

function resolveActiveScheduleWindow(preset, parts) {
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const windowDuration = scheduleWindowDurationMinutes(preset);
  if (
    preset.activeDays.includes(parts.weekday) &&
    minuteOfDay >= preset.startMinute
  ) {
    const elapsedMinutes = minuteOfDay - preset.startMinute;
    if (elapsedMinutes < windowDuration) {
      return { anchor: parts, elapsedMinutes, windowDuration };
    }
  }

  const yesterday = shiftLocalDate(parts, -1);
  if (preset.activeDays.includes(yesterday.weekday)) {
    const elapsedMinutes = 24 * 60 - preset.startMinute + minuteOfDay;
    if (elapsedMinutes >= 0 && elapsedMinutes < windowDuration) {
      return { anchor: yesterday, elapsedMinutes, windowDuration };
    }
  }

  return null;
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
  const activeWindow = resolveActiveScheduleWindow(preset, parts);
  const anchor = activeWindow?.anchor || null;
  const active = !!activeWindow;
  const slotMinutes = getScheduleSlotMinutes(preset);
  const slotOffset = activeWindow
    ? Math.floor(activeWindow.elapsedMinutes / slotMinutes) * slotMinutes
    : 0;
  const slotStartRelativeMinute = active
    ? preset.startMinute + slotOffset
    : null;
  const slotEndRelativeMinute = active
    ? preset.startMinute + Math.min(
        slotOffset + slotMinutes,
        activeWindow.windowDuration
      )
    : null;
  const windowEndRelativeMinute = active
    ? preset.startMinute + activeWindow.windowDuration
    : null;
  const slotStartAtMs = active
    ? utcMsFromAnchorRelativeMinute(
        anchor,
        slotStartRelativeMinute,
        preset.timeZone
      )
    : null;
  const slotEndAtMs = active
    ? utcMsFromAnchorRelativeMinute(
        anchor,
        slotEndRelativeMinute,
        preset.timeZone
      )
    : null;
  const windowEndAtMs = active
    ? utcMsFromAnchorRelativeMinute(
        anchor,
        windowEndRelativeMinute,
        preset.timeZone
      )
    : null;
  const key = active ? scheduledTaskKey(task, slotStartAtMs) : null;
  const completed = active && task?.completedForKey === key;

  let nextLabel = "";
  let nextAtMs = null;
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
      nextAtMs = zonedDateTimeToUtcMs(
        next,
        Math.floor(preset.startMinute / 60),
        preset.startMinute % 60,
        preset.timeZone
      );
      nextLabel = formatVietnamSourceScheduleLabel(nextAtMs);
    }
  }

  return {
    active,
    key,
    completed,
    anchorDateKey: anchor ? localDateKey(anchor) : "",
    scheduleText: preset.scheduleText,
    nextLabel,
    nextAtMs,
    slotStartAtMs,
    slotEndAtMs,
    windowEndAtMs,
    nextTransitionAtMs: active ? slotEndAtMs : nextAtMs,
  };
}

function formatSharedResetLabel(reset, lang) {
  // Lazy-require avoids circular import at module-load time. Optional
  // `lang` keeps the helper back-compat with callers that haven't been
  // migrated yet (default falls through to vi via t()).
  const { t } = require("../../services/i18n");
  if (reset === "daily") return t("shared-task.reset.daily", lang);
  if (reset === "weekly") return t("shared-task.reset.weekly", lang);
  if (reset === SCHEDULED_RESET) return t("shared-task.reset.scheduled", lang);
  return t("shared-task.reset.weekly", lang);
}

function getSharedTaskDisplay(task, now = new Date(), lang) {
  const { t } = require("../../services/i18n");
  const preset = getSharedTaskPreset(task?.preset);
  const name = String(task?.name || preset.defaultName).trim();
  if (task?.reset === SCHEDULED_RESET) {
    const state = resolveScheduledSharedTaskState(task, now);
    const activeEndsAtMs = state.slotEndAtMs || state.windowEndAtMs;
    const nextScheduleLabel = state.nextAtMs
      ? formatVietnamSourceScheduleLabel(state.nextAtMs)
      : state.nextLabel;
    const status = state.active
      ? activeEndsAtMs
        ? t("shared-task.status.nowOpenWithCloses", lang, {
            whenR: formatDiscordTimestamp(activeEndsAtMs, "R"),
            whenAbs: formatDiscordTimestamp(activeEndsAtMs, "f"),
          })
        : t("shared-task.status.nowOpen", lang)
      : state.nextAtMs
        ? t("shared-task.status.opensAt", lang, {
            whenR: formatDiscordTimestamp(state.nextAtMs, "R"),
            whenAbs: formatDiscordTimestamp(state.nextAtMs, "f"),
          })
        : nextScheduleLabel
          ? t("shared-task.status.opensAtShort", lang, { label: nextScheduleLabel })
          : preset.scheduleText;
    const optionStatus = state.active
      ? t("shared-task.status.nowOpen", lang)
      : state.nextAtMs
        ? t("shared-task.status.opensAtShort", lang, {
            label: formatVietnamScheduleLabel(state.nextAtMs),
          })
        : nextScheduleLabel
          ? t("shared-task.status.opensAtShort", lang, { label: nextScheduleLabel })
        : preset.scheduleText;
    return {
      name,
      emoji: preset.emoji,
      completed: state.completed,
      status,
      optionStatus,
      scheduleText: preset.scheduleText,
      active: state.active,
      key: state.key,
      nextAtMs: state.nextAtMs,
      slotStartAtMs: state.slotStartAtMs,
      slotEndAtMs: state.slotEndAtMs,
      windowEndAtMs: state.windowEndAtMs,
    };
  }
  return {
    name,
    emoji: preset.emoji,
    completed: !!task?.completed,
    status: formatSharedResetLabel(task?.reset, lang),
    optionStatus: formatSharedResetLabel(task?.reset, lang),
    scheduleText: formatSharedResetLabel(task?.reset, lang),
    active: true,
    key: null,
  };
}

function getNextSharedTaskTransitionMs(account, now = new Date()) {
  const nowMs = now.getTime();
  let nextMs = null;
  for (const task of getVisibleSharedTasks(account, nowMs)) {
    if (task?.reset !== SCHEDULED_RESET) continue;
    const state = resolveScheduledSharedTaskState(task, now);
    const candidateMs =
      state.nextTransitionAtMs ||
      (state.active ? state.windowEndAtMs : state.nextAtMs);
    if (!Number.isFinite(candidateMs) || candidateMs <= nowMs) continue;
    if (nextMs === null || candidateMs < nextMs) {
      nextMs = candidateMs;
    }
  }
  return nextMs;
}

module.exports = {
  PACIFIC_TIME_ZONE,
  SCHEDULE_SOURCE_TIME_ZONE,
  SCHEDULE_SOURCE_LABEL,
  VIETNAM_TIME_ZONE,
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
  getSharedTaskDisplay,
  getNextSharedTaskTransitionMs,
  formatSharedResetLabel,
  normalizeName,
};
