"use strict";

// tPick, not t: some titles here are variant pools; non-pool keys pass through.
const { tPick: t } = require("../../../../services/i18n");
const {
  generateTaskId,
  normalizeName,
  countByReset,
} = require("../../../../utils/raid/tasks/side-tasks");
const { capForReset } = require("./reset-policy");

/**
 * Add a side task to one character, unless its reset bucket is already full
 * or it already has a task with that name and reset.
 * @param {object[]} sideTasks - the character's side tasks (mutated on add)
 * @param {{taskName: string, reset: string}} request
 * @param {number} cycleStart - the reset cycle the new task starts in
 * @returns {"added"|"cap-reached"|"duplicate"}
 */
function tryAddSideTask(sideTasks, { taskName, reset }, cycleStart) {
  if (countByReset(sideTasks, reset) >= capForReset(reset)) return "cap-reached";
  const name = normalizeName(taskName);
  const duplicate = sideTasks.some(
    (task) => normalizeName(task?.name) === name && task?.reset === reset
  );
  if (duplicate) return "duplicate";
  sideTasks.push({
    taskId: generateTaskId(),
    name: taskName,
    reset,
    completed: false,
    lastResetAt: cycleStart,
    createdAt: Date.now(),
  });
  return "added";
}

function cycleLabelForReset(reset, lang) {
  return reset === "daily"
    ? t("raid-task.add.cycleDailyLabel", lang)
    : t("raid-task.add.cycleWeeklyLabel", lang);
}

function invalidTaskNameNotice(lang) {
  return {
    type: "warn",
    title: t("raid-task.common.invalidTaskNameTitle", lang),
    description: t("raid-task.common.invalidTaskNameDescription", lang),
  };
}

function noRosterNotice(lang) {
  return {
    type: "warn",
    title: t("raid-task.common.noRosterTitle", lang),
    description: t("raid-task.common.noRosterDescription", lang),
  };
}

module.exports = {
  tryAddSideTask,
  cycleLabelForReset,
  invalidTaskNameNotice,
  noRosterNotice,
};
