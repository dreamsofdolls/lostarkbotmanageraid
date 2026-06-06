"use strict";

const {
  SCHEDULE_SOURCE_TIME_ZONE,
  SCHEDULE_SOURCE_LABEL,
  VIETNAM_TIME_ZONE,
  getSharedTaskPreset,
} = require("./config");

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_VN = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

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

module.exports = {
  WEEKDAY_SHORT,
  WEEKDAY_VN,
  getZonedParts,
  shiftLocalDate,
  zonedDateTimeToUtcMs,
  formatDiscordTimestamp,
  formatVietnamSourceScheduleLabel,
  formatVietnamScheduleLabel,
  localDateKey,
  utcDateKey,
  scheduledTaskKey,
  scheduleWindowDurationMinutes,
  getScheduleSlotMinutes,
  resolveActiveScheduleWindow,
  resolveScheduledSharedTaskState,
};
