"use strict";

const { t, getUserLanguage } = require("../../../services/i18n");
const { resolveEditableTaskWriteAccess } = require("./write-access");
const {
  ensureSharedTasks,
} = require("../../../utils/raid/tasks/shared-tasks");
const {
  findAccountInUser,
} = require("../../../utils/raid/tasks/side-tasks");
const {
  createSharedAddHandler,
  resolveSharedTaskReset,
} = require("./shared/shared-add");

function createRaidTaskSharedActionHandlers({
  User,
  saveWithRetry,
  dailyResetStartMs,
  weekResetStartMs,
  resolveTaskWriteTarget,
  replyTaskNotice,
  replyViewOnlyShareNotice,
}) {
  const handleSharedAdd = createSharedAddHandler({
    User,
    saveWithRetry,
    dailyResetStartMs,
    weekResetStartMs,
    resolveTaskWriteTarget,
    replyTaskNotice,
    replyViewOnlyShareNotice,
  });

  async function handleSharedRemove(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const taskId = interaction.options.getString("task", true);

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName,
      commandName: "shared-remove",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;
    const discordId = access.discordId;

    let outcome = "removed";
    let resolvedRosterName = rosterName;
    let removedTaskName = "";

    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId });
        if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
          outcome = "no-roster";
          return;
        }
        const account = findAccountInUser(userDoc, rosterName);
        if (!account) {
          outcome = "no-roster-match";
          return;
        }
        resolvedRosterName = account.accountName;
        const sharedTasks = ensureSharedTasks(account);
        const idx = sharedTasks.findIndex((task) => task?.taskId === taskId);
        if (idx === -1) {
          outcome = "task-not-found";
          return;
        }
        removedTaskName = sharedTasks[idx]?.name || t("raid-task.unnamedTaskFallback", lang);
        sharedTasks.splice(idx, 1);
        await userDoc.save();
      });
    } catch (error) {
      console.error("[raid-task shared-remove] save failed:", error?.message || error);
      await replyTaskNotice(interaction, {
        type: "error",
        title: t("raid-task.save.addFailedTitle", lang),
        description: t("raid-task.save.sharedRemoveFailedDescription", lang),
      });
      return;
    }

    if (outcome === "no-roster" || outcome === "no-roster-match") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.rosterNotFoundTitle", lang),
        description: t("raid-task.common.rosterNotFoundDescription", lang, {
          rosterName,
        }),
      });
      return;
    }
    if (outcome === "task-not-found") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.sharedRemove.noTaskTitle", lang),
        description: t("raid-task.sharedRemove.noTaskDescription", lang),
      });
      return;
    }

    await replyTaskNotice(interaction, {
      type: "success",
      title: t("raid-task.sharedRemove.successTitle", lang),
      description: t("raid-task.sharedRemove.successDescription", lang, {
        rosterName: resolvedRosterName,
        taskName: removedTaskName,
      }),
    });
  }

  return {
    handleSharedAdd,
    handleSharedRemove,
  };
}

module.exports = {
  createRaidTaskSharedActionHandlers,
  resolveSharedTaskReset,
};
