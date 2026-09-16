"use strict";

const { tPick: t } = require("../../../services/i18n");
const { createTaskMutationHandler } = require("./write-handler");
const { getCharacterDisplayName, findCharacterInUser, findAccountInUser, ensureSideTasks } = require("../../../utils/raid/tasks/side-tasks");
const { ensureSharedTasks } = require("../../../utils/raid/tasks/shared-tasks");

/**
 * Remove one character or shared-roster task through the same guarded write
 * lifecycle.
 * @param {object} deps - services passed through to the mutation handler.
 * @param {object} [options]
 * @param {boolean} [options.shared=false] - target shared-roster tasks
 *   (command `shared-remove`) instead of one character's side tasks.
 * @returns {Function} async interaction handler.
 */
function createTaskRemoveHandler(deps, { shared = false } = {}) {
  const commandName = shared ? "shared-remove" : "remove";
  const noticePrefix = shared ? "sharedRemove" : "remove";
  const missingPrefix = shared ? "rosterNotFound" : "noCharacter";
  const displayKey = shared ? "rosterName" : "characterName";
  return createTaskMutationHandler(deps, {
    commandName,
    saveFailedDescriptionKey: `raid-task.save.${noticePrefix}FailedDescription`,
    readRequest: interaction => ({
      rosterName: interaction.options.getString("roster", true),
      characterName: shared ? null : interaction.options.getString("character", true),
      taskId: interaction.options.getString("task", true),
    }),
    createResult: () => ({ outcome: "removed" }),
    applyToUserDoc(userDoc, request, result) {
      const target = shared
        ? findAccountInUser(userDoc, request.rosterName)
        : findCharacterInUser(userDoc, request.characterName, request.rosterName)?.character;
      if (!target) {
        result.outcome = "missing-target";
        return false;
      }
      result.displayName = shared ? target.accountName : getCharacterDisplayName(target);
      const tasks = shared ? ensureSharedTasks(target) : ensureSideTasks(target);
      const index = tasks.findIndex(task => task?.taskId === request.taskId);
      if (index === -1) {
        result.outcome = "task-not-found";
        return false;
      }
      result.taskName = tasks[index]?.name;
      tasks.splice(index, 1);
      return true;
    },
    buildNotice(result, request, lang) {
      if (result.outcome === "missing-target") return {
        type: "warn",
        title: t(`raid-task.common.${missingPrefix}Title`, lang),
        description: t(`raid-task.common.${missingPrefix}Description`, lang, { [displayKey]: request[displayKey] }),
      };
      if (result.outcome === "task-not-found") return {
        type: "warn",
        title: t(`raid-task.${noticePrefix}.noTaskTitle`, lang),
        description: t(`raid-task.${noticePrefix}.noTaskDescription`, lang),
      };
      return {
        type: "success",
        title: t(`raid-task.${noticePrefix}.successTitle`, lang),
        description: t(`raid-task.${noticePrefix}.successDescription`, lang, {
          [displayKey]: result.displayName,
          taskName: result.taskName || t("raid-task.unnamedTaskFallback", lang),
        }),
      };
    },
  });
}

/**
 * Build the raid task remove action handlers.
 * @param {object} deps - services passed through to the mutation handler.
 * @returns {{handleRemove: Function}} handlers keyed by action name.
 */
function createRaidTaskRemoveActionHandlers(deps) {
  return { handleRemove: createTaskRemoveHandler(deps) };
}

module.exports = { createRaidTaskRemoveActionHandlers, createTaskRemoveHandler };
