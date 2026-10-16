/**
 * utils/raid/tasks/task-cycle.js
 * Reset-cycle rule for daily and weekly tasks, shared by the /raid-status
 * toggle write path and the task view. A task's stored completion belongs to
 * the current cycle only when its lastResetAt is at or after the cycle start.
 */

"use strict";

const { dailyResetStartMs, weeklyResetStartMs } = require("../schedule/reset-windows");

const CYCLE_START_BY_RESET = Object.freeze({
  daily: dailyResetStartMs,
  weekly: weeklyResetStartMs,
});

/**
 * Whether a task's stored state belongs to the reset cycle that contains
 * `now`. A task with no daily or weekly cycle (a scheduled shared task) always does.
 * @param {{reset?: string, lastResetAt?: number}|null} task - Side or shared task.
 * @param {Date|number} [now=new Date()] - Clock used to find the cycle start.
 * @returns {boolean} False when lastResetAt predates the current cycle start.
 */
function isTaskInCurrentCycle(task, now = new Date()) {
  const cycleStart = CYCLE_START_BY_RESET[task?.reset]?.(now);
  return !cycleStart || Number(task.lastResetAt) >= cycleStart;
}

/**
 * Whether a task shows as done: completed, and in the current reset cycle.
 * @param {{completed?: boolean, reset?: string, lastResetAt?: number}|null} task - Side or shared task.
 * @param {Date|number} [now=new Date()] - Clock used to find the cycle start.
 * @returns {boolean} False for a task not completed or completed in an earlier cycle.
 */
function isTaskDone(task, now = new Date()) {
  return Boolean(task?.completed) && isTaskInCurrentCycle(task, now);
}

module.exports = {
  CYCLE_START_BY_RESET,
  isTaskDone,
  isTaskInCurrentCycle,
};
