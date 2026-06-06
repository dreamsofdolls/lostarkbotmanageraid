"use strict";

const {
  SCHEDULED_RESET,
  getSharedTaskPreset,
} = require("./config");
const { getVisibleSharedTasks } = require("./state");
const {
  formatDiscordTimestamp,
  formatVietnamScheduleLabel,
  formatVietnamSourceScheduleLabel,
  resolveScheduledSharedTaskState,
} = require("./schedule");

function formatSharedResetLabel(reset, lang) {
  const { t } = require("../../../../services/i18n");
  if (reset === "daily") return t("shared-task.reset.daily", lang);
  if (reset === "weekly") return t("shared-task.reset.weekly", lang);
  if (reset === SCHEDULED_RESET) return t("shared-task.reset.scheduled", lang);
  return t("shared-task.reset.weekly", lang);
}

function getSharedTaskDisplay(task, now = new Date(), lang) {
  const { t } = require("../../../../services/i18n");
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
  formatSharedResetLabel,
  getSharedTaskDisplay,
  getNextSharedTaskTransitionMs,
};
