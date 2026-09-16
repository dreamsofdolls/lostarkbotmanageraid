"use strict";

const { tPick: t, getUserLanguage } = require("../../../services/i18n");
const { resolveEditableTaskWriteAccess, revalidateTaskWriteAccess } = require("./write-access");

/**
 * Shared access, retry and reply lifecycle for task additions and removals.
 * @param {object} deps - shared services for every task command.
 * @param {object} deps.User - User mongoose model.
 * @param {Function} deps.saveWithRetry - runs each write attempt with retry.
 * @param {Function} deps.dailyResetStartMs - daily reset boundary helper.
 * @param {Function} deps.weekResetStartMs - weekly reset boundary helper.
 * @param {Function} deps.resolveTaskWriteTarget - shared-roster access resolver.
 * @param {Function} deps.replyTaskNotice - sends the command's notice reply.
 * @param {Function} deps.replyViewOnlyShareNotice - sends the view-only denial.
 * @param {object} spec - per-command behavior.
 * @param {string} spec.commandName - command label for share and save-failure logs.
 * @param {Function} spec.readRequest - extracts the request (rosterName, ...)
 *   from the interaction.
 * @param {Function} [spec.buildValidationNotice] - early reply that skips the
 *   write path when the request is invalid.
 * @param {Function} spec.createResult - fresh per-attempt result object.
 * @param {Function} spec.applyToUserDoc - mutates the user doc; return true
 *   only when a save is needed.
 * @param {Function} spec.buildNotice - final reply from the attempt result.
 * @param {string} spec.saveFailedDescriptionKey - i18n key for save failures.
 * @returns {Function} async interaction handler.
 */
function createTaskMutationHandler({
  User, saveWithRetry, dailyResetStartMs, weekResetStartMs,
  resolveTaskWriteTarget, replyTaskNotice, replyViewOnlyShareNotice,
}, {
  commandName, readRequest, buildValidationNotice = () => null, createResult,
  applyToUserDoc, buildNotice, saveFailedDescriptionKey,
}) {
  return async function handleTaskMutation(interaction) {
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
    let access = { discordId: executorId };
    if (!request.applyAllRosters) {
      access = await resolveEditableTaskWriteAccess({
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
        if (!await revalidateTaskWriteAccess({
          access, executorId, rosterName: request.rosterName, resolveTaskWriteTarget,
          denyViewOnly: (target) => replyViewOnlyShareNotice(interaction, target, lang),
        })) return null;
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
    if (result) await replyTaskNotice(interaction, buildNotice(result, request, lang));
  };
}

module.exports = { createTaskMutationHandler };
