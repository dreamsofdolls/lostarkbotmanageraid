"use strict";

function sanitizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((task) => task && task.id)
    .map((task) => ({
      id: String(task.id),
      completions: Number(task.completions) || 0,
      completionDate: Number(task.completionDate) || undefined,
    }));
}

function sanitizeSideTasks(sideTasks) {
  if (!Array.isArray(sideTasks)) return [];
  return sideTasks
    .filter((task) => task && task.taskId && task.name)
    .map((task) => ({
      taskId: String(task.taskId),
      name: String(task.name),
      reset: task.reset === "weekly" ? "weekly" : "daily",
      completed: Boolean(task.completed),
      lastResetAt: Number(task.lastResetAt) || 0,
      createdAt: Number(task.createdAt) || Date.now(),
    }));
}

module.exports = {
  sanitizeSideTasks,
  sanitizeTasks,
};
