/**
 * handlers/raid-status/task/task-actions.js
 * Pure helpers for the /raid-status task-toggle dropdown · parse the
 * select-menu value into a kind discriminator, resolve scheduled-
 * shared-task state for time-windowed presets (Chaos Gate, Field
 * Boss). Kept dep-free so the task-ui module can use them without a
 * heavy import.
 */

const { normalizeName } = require("../../../utils/raid/common/shared");
const { resolveScheduledSharedTaskState } = require("../../../utils/raid/tasks/shared-tasks");
const { dailyResetStartMs, weeklyResetStartMs } = require("../../../utils/raid/schedule/reset-windows");
const { findAccountByName } = require("../../../utils/user-doc");

const CYCLE_START_BY_RESET = Object.freeze({
  daily: dailyResetStartMs,
  weekly: weeklyResetStartMs,
});

// The side-task reset scheduler ticks every 30 minutes, so a clicked task can
// still carry the previous cycle. Reset it the way that tick would, so the
// toggle starts from this cycle and the tick then leaves the result alone.
function freshenTaskCycle(task, now) {
  const cycleStart = CYCLE_START_BY_RESET[task?.reset]?.(now);
  if (!cycleStart || Number(task.lastResetAt) >= cycleStart) return;
  task.completed = false;
  task.lastResetAt = cycleStart;
}

function parseTaskToggleValue(value) {
  if (!value || value === "noop") return { kind: "noop" };

  if (value.startsWith("shared::")) {
    const taskId = value.slice("shared::".length);
    if (!taskId) return { kind: "invalid" };
    return { kind: "shared", taskId };
  }

  if (value.startsWith("__all__::")) {
    const parts = value.split("::");
    const targetReset = parts[1] || "";
    const targetNameLower = parts.slice(2).join("::");
    if (!targetReset || !targetNameLower) return { kind: "invalid" };
    return {
      kind: "bulk",
      targetReset,
      targetNameLower,
    };
  }

  const sepIdx = value.indexOf("::");
  const targetCharName = sepIdx > 0 ? value.slice(0, sepIdx) : "";
  const targetTaskId = sepIdx > 0 ? value.slice(sepIdx + 2) : "";
  if (!targetCharName || !targetTaskId) return { kind: "invalid" };
  return {
    kind: "single",
    targetCharName,
    targetTaskId,
  };
}

async function mutateFreshAccount(options, mutateAccount) {
  const {
    User,
    saveWithRetry,
    discordId,
    targetAccountName,
    canWrite = null,
  } = options;
  let denied = false;
  await saveWithRetry(async () => {
    // Asked on every attempt: a retry follows another write, which can be
    // the owner revoking the share this write relied on.
    if (canWrite && !(await canWrite())) {
      denied = true;
      return;
    }
    const userDocFresh = await User.findOne({ discordId });
    const account = findAccountByName(userDocFresh, targetAccountName, normalizeName);
    if (!account) return;

    const changed = await mutateAccount(account);
    if (!changed) return;
    await userDocFresh.save();
  });
  return { denied };
}

async function toggleBulkSideTask(options) {
  const {
    targetReset,
    targetNameLower,
    now = new Date(),
  } = options;

  return mutateFreshAccount(options, (account) => {
    if (!Array.isArray(account.characters)) return false;

    const owners = [];
    for (const ch of account.characters) {
      if (!Array.isArray(ch?.sideTasks)) continue;
      const task = ch.sideTasks.find(
        (t) =>
          normalizeName(t?.name) === targetNameLower &&
          t?.reset === targetReset
      );
      if (task) owners.push({ task });
    }
    if (owners.length === 0) return false;

    for (const { task } of owners) freshenTaskCycle(task, now);
    const allDone = owners.every((o) => o.task.completed);
    const nextState = !allDone;
    for (const { task } of owners) {
      task.completed = nextState;
    }
    return true;
  });
}

async function toggleSingleSideTask(options) {
  const {
    targetCharName,
    targetTaskId,
    now = new Date(),
  } = options;

  return mutateFreshAccount(options, (account) => {
    if (!Array.isArray(account.characters)) return false;

    const target = account.characters.find(
      (c) => normalizeName(c?.name) === normalizeName(targetCharName)
    );
    if (!target) return false;
    if (!Array.isArray(target.sideTasks)) target.sideTasks = [];
    const task = target.sideTasks.find((t) => t?.taskId === targetTaskId);
    if (!task) return false;
    freshenTaskCycle(task, now);
    task.completed = !task.completed;
    return true;
  });
}

async function toggleSharedTask(options) {
  const {
    taskId,
    now = new Date(),
  } = options;

  return mutateFreshAccount(options, (account) => {
    if (!Array.isArray(account.sharedTasks)) return false;

    const task = account.sharedTasks.find((t) => t?.taskId === taskId);
    if (!task || Number(task.archivedAt) > 0) return false;
    const expiresAt = Number(task.expiresAt) || 0;
    if (expiresAt > 0 && expiresAt < now.getTime()) return false;

    if (task.reset === "scheduled") {
      const state = resolveScheduledSharedTaskState(task, now);
      if (!state.active || !state.key) return false;
      if (task.completedForKey === state.key) {
        task.completedForKey = "";
        task.completed = false;
        task.completedAt = null;
      } else {
        task.completedForKey = state.key;
        task.completed = true;
        task.completedAt = now.getTime();
      }
    } else {
      freshenTaskCycle(task, now);
      task.completed = !task.completed;
      task.completedAt = task.completed ? now.getTime() : null;
    }
    return true;
  });
}

const TASK_TOGGLE_RUNNERS = Object.freeze({
  shared: {
    errorLabel: "[raid-status shared-task toggle] save failed:",
    run: ({ User, saveWithRetry, discordId, targetAccountName, canWrite, parsed, now }) =>
      toggleSharedTask({
        User,
        saveWithRetry,
        discordId,
        targetAccountName,
        canWrite,
        taskId: parsed.taskId,
        now,
      }),
  },
  bulk: {
    errorLabel: "[raid-status side-task bulk-toggle] save failed:",
    run: ({ User, saveWithRetry, discordId, targetAccountName, canWrite, parsed, now }) =>
      toggleBulkSideTask({
        User,
        saveWithRetry,
        discordId,
        targetAccountName,
        canWrite,
        targetReset: parsed.targetReset,
        targetNameLower: parsed.targetNameLower,
        now,
      }),
  },
  single: {
    errorLabel: "[raid-status side-task toggle] save failed:",
    run: ({ User, saveWithRetry, discordId, targetAccountName, canWrite, parsed, now }) =>
      toggleSingleSideTask({
        User,
        saveWithRetry,
        discordId,
        targetAccountName,
        canWrite,
        targetCharName: parsed.targetCharName,
        targetTaskId: parsed.targetTaskId,
        now,
      }),
  },
});

async function toggleParsedSideTask(options) {
  const {
    parsed,
    logger = console,
  } = options;
  const runner = TASK_TOGGLE_RUNNERS[parsed?.kind];
  if (!runner) return { handled: false, ok: false };

  try {
    const { denied } = await runner.run(options);
    if (denied) return { handled: true, ok: false, denied: true };
    return { handled: true, ok: true };
  } catch (err) {
    logger.error?.(runner.errorLabel, err?.message || err);
    return { handled: true, ok: false, error: err };
  }
}

module.exports = {
  parseTaskToggleValue,
  toggleParsedSideTask,
};
