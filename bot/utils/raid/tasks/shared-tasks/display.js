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

const SHARED_RESET_LABEL_KEY_BY_TYPE = new Map([
  ["daily", "shared-task.reset.daily"],
  ["weekly", "shared-task.reset.weekly"],
  [SCHEDULED_RESET, "shared-task.reset.scheduled"],
]);

function formatSharedResetLabel(reset, lang) {
  const { t } = require("../../../../services/i18n");
  const labelKey = SHARED_RESET_LABEL_KEY_BY_TYPE.get(reset)
    || "shared-task.reset.weekly";
  return t(labelKey, lang);
}

function formatScheduledStatus(state, nextScheduleLabel, fallback, lang) {
  const { t } = require("../../../../services/i18n");
  const activeEndsAtMs = state.slotEndAtMs || state.windowEndAtMs;
  if (state.active && activeEndsAtMs) {
    return t("shared-task.status.nowOpenWithCloses", lang, {
      whenR: formatDiscordTimestamp(activeEndsAtMs, "R"),
      whenAbs: formatDiscordTimestamp(activeEndsAtMs, "f"),
    });
  }
  if (state.active) return t("shared-task.status.nowOpen", lang);
  if (state.nextAtMs) {
    return t("shared-task.status.opensAt", lang, {
      whenR: formatDiscordTimestamp(state.nextAtMs, "R"),
      whenAbs: formatDiscordTimestamp(state.nextAtMs, "f"),
    });
  }
  return nextScheduleLabel
    ? t("shared-task.status.opensAtShort", lang, { label: nextScheduleLabel })
    : fallback;
}

function formatScheduledOptionStatus(state, nextScheduleLabel, fallback, lang) {
  const { t } = require("../../../../services/i18n");
  if (state.active) return t("shared-task.status.nowOpen", lang);
  const label = state.nextAtMs
    ? formatVietnamScheduleLabel(state.nextAtMs)
    : nextScheduleLabel;
  return label
    ? t("shared-task.status.opensAtShort", lang, { label })
    : fallback;
}

function getSharedTaskDisplay(task, now = new Date(), lang) {
  const { t } = require("../../../../services/i18n");
  const preset = getSharedTaskPreset(task?.preset);
  const name = String(task?.name || preset.defaultName).trim();
  if (task?.reset === SCHEDULED_RESET) {
    const state = resolveScheduledSharedTaskState(task, now);
    const nextScheduleLabel = state.nextAtMs
      ? formatVietnamSourceScheduleLabel(state.nextAtMs)
      : state.nextLabel;
    const status = formatScheduledStatus(
      state,
      nextScheduleLabel,
      preset.scheduleText,
      lang,
    );
    const optionStatus = formatScheduledOptionStatus(
      state,
      nextScheduleLabel,
      preset.scheduleText,
      lang,
    );
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
