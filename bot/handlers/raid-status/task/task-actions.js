/**
 * handlers/raid-status/task-actions.js
 * Pure helpers for the /raid-status task-toggle dropdown · parse the
 * select-menu value into a kind discriminator, resolve scheduled-
 * shared-task state for time-windowed presets (Chaos Gate, Field
 * Boss). Kept dep-free so the task-ui module can use them without a
 * heavy import.
 */

const { normalizeName } = require("../../../utils/raid/common/shared");
const { resolveScheduledSharedTaskState } = require("../../../utils/raid/tasks/shared-tasks");

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
  } = options;
  const normalizedTargetAccountName = normalizeName(targetAccountName);

  await saveWithRetry(async () => {
    const userDocFresh = await User.findOne({ discordId });
    if (!userDocFresh || !Array.isArray(userDocFresh.accounts)) return;

    const account = userDocFresh.accounts.find(
      (candidate) =>
        normalizeName(candidate?.accountName) === normalizedTargetAccountName
    );
    if (!account) return;

    const changed = await mutateAccount(account);
    if (!changed) return;
    await userDocFresh.save();
  });
}

async function toggleBulkSideTask(options) {
  const {
    targetReset,
    targetNameLower,
  } = options;

  await mutateFreshAccount(options, (account) => {
    if (!Array.isArray(account.characters)) return false;

    const owners = [];
    for (const ch of account.characters) {
      if (!Array.isArray(ch?.sideTasks)) continue;
      const task = ch.sideTasks.find(
        (t) =>
          String(t?.name || "").trim().toLowerCase() === targetNameLower &&
          t?.reset === targetReset
      );
      if (task) owners.push({ task });
    }
    if (owners.length === 0) return false;

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
  } = options;

  await mutateFreshAccount(options, (account) => {
    if (!Array.isArray(account.characters)) return false;

    const target = account.characters.find(
      (c) =>
        String(c?.name || "").trim().toLowerCase() ===
        targetCharName.trim().toLowerCase()
    );
    if (!target) return false;
    if (!Array.isArray(target.sideTasks)) target.sideTasks = [];
    const task = target.sideTasks.find((t) => t?.taskId === targetTaskId);
    if (!task) return false;
    task.completed = !task.completed;
    return true;
  });
}

async function toggleSharedTask(options) {
  const {
    taskId,
    now = new Date(),
  } = options;

  await mutateFreshAccount(options, (account) => {
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
      task.completed = !task.completed;
      task.completedAt = task.completed ? now.getTime() : null;
    }
    return true;
  });
}

const TASK_TOGGLE_RUNNERS = Object.freeze({
  shared: {
    errorLabel: "[raid-status shared-task toggle] save failed:",
    run: ({ User, saveWithRetry, discordId, targetAccountName, parsed, now }) =>
      toggleSharedTask({
        User,
        saveWithRetry,
        discordId,
        targetAccountName,
        taskId: parsed.taskId,
        now,
      }),
  },
  bulk: {
    errorLabel: "[raid-status side-task bulk-toggle] save failed:",
    run: ({ User, saveWithRetry, discordId, targetAccountName, parsed }) =>
      toggleBulkSideTask({
        User,
        saveWithRetry,
        discordId,
        targetAccountName,
        targetReset: parsed.targetReset,
        targetNameLower: parsed.targetNameLower,
      }),
  },
  single: {
    errorLabel: "[raid-status side-task toggle] save failed:",
    run: ({ User, saveWithRetry, discordId, targetAccountName, parsed }) =>
      toggleSingleSideTask({
        User,
        saveWithRetry,
        discordId,
        targetAccountName,
        targetCharName: parsed.targetCharName,
        targetTaskId: parsed.targetTaskId,
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
    await runner.run(options);
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
