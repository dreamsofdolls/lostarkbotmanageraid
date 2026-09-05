"use strict";

const { tPick: t, getUserLanguage } = require("../../../../services/i18n");
const { resolveEditableTaskWriteAccess } = require("../write-access");

/** Shared validation, access and save lifecycle for the three task-add commands. */
function createTaskAddHandler({
  User, saveWithRetry, dailyResetStartMs, weekResetStartMs,
  resolveTaskWriteTarget, replyTaskNotice, replyViewOnlyShareNotice,
}, {
  commandName, readRequest, buildValidationNotice, createResult,
  applyToUserDoc, buildNotice, saveFailedDescriptionKey,
}) {
  return async function handleTaskAdd(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const request = readRequest(interaction);
    const validationNotice = buildValidationNotice(request, lang);
    if (validationNotice) {
      await replyTaskNotice(interaction, validationNotice);
      return;
    }

    // Only shared-add exposes all_rosters, and it always targets the executor's
    // own accounts. A share grant must never expand into access to other rosters.
    let discordId = executorId;
    if (!request.applyAllRosters) {
      const access = await resolveEditableTaskWriteAccess({
        executorId, rosterName: request.rosterName, commandName, resolveTaskWriteTarget,
        denyViewOnly: (target) => replyViewOnlyShareNotice(interaction, target, lang),
      });
      if (!access.ok) return;
      discordId = access.discordId;
    }

    const now = Date.now();
    let result;
    try {
      result = await saveWithRetry(async () => {
        // Both the document and reply data belong to this attempt. A failed save
        // must not inflate counts or trigger a redundant save on the next one.
        const attemptResult = createResult(request.rosterName);
        const userDoc = await User.findOne({ discordId });
        if (applyToUserDoc(userDoc, request, attemptResult, { dailyResetStartMs, weekResetStartMs }, now)) {
          await userDoc.save();
        }
        return attemptResult;
      });
    } catch (error) {
      const logLabel = commandName === "add-single" ? "add" : commandName;
      console.error(`[raid-task ${logLabel}] save failed:`, error?.message || error);
      await replyTaskNotice(interaction, {
        type: "error",
        title: t("raid-task.save.addFailedTitle", lang),
        description: t(saveFailedDescriptionKey, lang),
      });
      return;
    }
    await replyTaskNotice(interaction, buildNotice(result, request, lang));
  };
}

module.exports = { createTaskAddHandler };
