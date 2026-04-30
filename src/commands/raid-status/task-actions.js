const { normalizeName } = require("../../raid/shared");
const { resolveScheduledSharedTaskState } = require("../../raid/shared-tasks");

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

async function toggleBulkSideTask(options) {
  const {
    User,
    saveWithRetry,
    discordId,
    targetAccountName,
    targetReset,
    targetNameLower,
  } = options;

  await saveWithRetry(async () => {
    const userDocFresh = await User.findOne({ discordId });
    if (!userDocFresh || !Array.isArray(userDocFresh.accounts)) return;
    const account = userDocFresh.accounts.find(
      (a) => normalizeName(a?.accountName) === normalizeName(targetAccountName)
    );
    if (!account || !Array.isArray(account.characters)) return;

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
    if (owners.length === 0) return;

    const allDone = owners.every((o) => o.task.completed);
    const nextState = !allDone;
    for (const { task } of owners) {
      task.completed = nextState;
    }
    await userDocFresh.save();
  });
}

async function toggleSingleSideTask(options) {
  const {
    User,
    saveWithRetry,
    discordId,
    targetAccountName,
    targetCharName,
    targetTaskId,
  } = options;

  await saveWithRetry(async () => {
    const userDocFresh = await User.findOne({ discordId });
    if (!userDocFresh || !Array.isArray(userDocFresh.accounts)) return;
    const account = userDocFresh.accounts.find(
      (a) => normalizeName(a?.accountName) === normalizeName(targetAccountName)
    );
    if (!account || !Array.isArray(account.characters)) return;

    const target = account.characters.find(
      (c) =>
        String(c?.name || "").trim().toLowerCase() ===
        targetCharName.trim().toLowerCase()
    );
    if (!target) return;
    if (!Array.isArray(target.sideTasks)) target.sideTasks = [];
    const task = target.sideTasks.find((t) => t?.taskId === targetTaskId);
    if (!task) return;
    task.completed = !task.completed;
    await userDocFresh.save();
  });
}

async function toggleSharedTask(options) {
  const {
    User,
    saveWithRetry,
    discordId,
    targetAccountName,
    taskId,
    now = new Date(),
  } = options;

  await saveWithRetry(async () => {
    const userDocFresh = await User.findOne({ discordId });
    if (!userDocFresh || !Array.isArray(userDocFresh.accounts)) return;
    const account = userDocFresh.accounts.find(
      (a) => normalizeName(a?.accountName) === normalizeName(targetAccountName)
    );
    if (!account || !Array.isArray(account.sharedTasks)) return;

    const task = account.sharedTasks.find((t) => t?.taskId === taskId);
    if (!task || Number(task.archivedAt) > 0) return;
    const expiresAt = Number(task.expiresAt) || 0;
    if (expiresAt > 0 && expiresAt < now.getTime()) return;

    if (task.reset === "scheduled") {
      const state = resolveScheduledSharedTaskState(task, now);
      if (!state.active || !state.key) return;
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
    await userDocFresh.save();
  });
}

module.exports = {
  parseTaskToggleValue,
  toggleBulkSideTask,
  toggleSingleSideTask,
  toggleSharedTask,
};
