"use strict";

const { t, getUserLanguage } = require("../../../services/i18n");
const { resolveEditableTaskWriteAccess } = require("./write-access");
const {
  getCharacterDisplayName,
  findCharacterInUser,
  ensureSideTasks,
} = require("../../../utils/raid/tasks/side-tasks");

function createRaidTaskRemoveActionHandlers({
  User,
  saveWithRetry,
  resolveTaskWriteTarget,
  replyTaskNotice,
  replyViewOnlyShareNotice,
}) {
  async function handleRemove(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const characterName = interaction.options.getString("character", true);
    const taskId = interaction.options.getString("task", true);

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName,
      commandName: "remove",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;
    const discordId = access.discordId;

    let outcome = "removed";
    let resolvedCharName = "";
    let removedTaskName = "";

    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId });
        if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
          outcome = "no-roster";
          return;
        }
        const found = findCharacterInUser(userDoc, characterName, rosterName);
        if (!found) {
          outcome = "no-character";
          return;
        }
        resolvedCharName = getCharacterDisplayName(found.character);
        const sideTasks = ensureSideTasks(found.character);
        const idx = sideTasks.findIndex((task) => task?.taskId === taskId);
        if (idx === -1) {
          outcome = "task-not-found";
          return;
        }
        removedTaskName = sideTasks[idx]?.name || t("raid-task.unnamedTaskFallback", lang);
        sideTasks.splice(idx, 1);
        await userDoc.save();
      });
    } catch (error) {
      console.error("[raid-task remove] save failed:", error?.message || error);
      await replyTaskNotice(interaction, {
        type: "error",
        title: t("raid-task.save.addFailedTitle", lang),
        description: t("raid-task.save.removeFailedDescription", lang),
      });
      return;
    }

    if (outcome === "no-roster" || outcome === "no-character") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.common.noCharacterTitle", lang),
        description: t("raid-task.common.noCharacterDescription", lang, {
          characterName,
        }),
      });
      return;
    }
    if (outcome === "task-not-found") {
      await replyTaskNotice(interaction, {
        type: "warn",
        title: t("raid-task.remove.noTaskTitle", lang),
        description: t("raid-task.remove.noTaskDescription", lang),
      });
      return;
    }

    await replyTaskNotice(interaction, {
      type: "success",
      title: t("raid-task.remove.successTitle", lang),
      description: t("raid-task.remove.successDescription", lang, {
        characterName: resolvedCharName,
        taskName: removedTaskName,
      }),
    });
  }

  return {
    handleRemove,
  };
}

module.exports = {
  createRaidTaskRemoveActionHandlers,
};
