"use strict";

const { tPick: t } = require("../../../services/i18n");
const { createTaskMutationHandler } = require("./write-handler");
const { getCharacterDisplayName, findCharacterInUser, findAccountInUser, ensureSideTasks } = require("../../../utils/raid/tasks/side-tasks");
const { ensureSharedTasks } = require("../../../utils/raid/tasks/shared-tasks");
const {
  NoticeKind,
  buildRosterNotFoundNotice,
  formatCharacterLabel,
  getCharacterClass,
} = require("../../../utils/raid/common/shared");

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
      result.displayName = shared
        ? target.accountName
        : formatCharacterLabel(getCharacterDisplayName(target), getCharacterClass(target));
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
      if (result.outcome === "missing-target") {
        if (shared) return buildRosterNotFoundNotice(request.rosterName, lang);
        return {
          kind: NoticeKind.EMPTY,
          title: t("raid-task.common.noCharacterTitle", lang),
          description: t("raid-task.common.noCharacterDescription", lang, { characterName: request.characterName }),
          tip: t("raid-task.common.noCharacterTip", lang),
        };
      }
      // The task id came from autocomplete, so a miss means it was removed since.
      if (result.outcome === "task-not-found") return {
        kind: NoticeKind.EXPIRED,
        title: t(`raid-task.${noticePrefix}.noTaskTitle`, lang),
        description: t(`raid-task.${noticePrefix}.noTaskDescription`, lang),
        tip: t(`raid-task.${noticePrefix}.noTaskTip`, lang),
      };
      return {
        kind: NoticeKind.DONE,
        title: t(`raid-task.${noticePrefix}.successTitle`, lang),
        description: t(`raid-task.${noticePrefix}.successDescription`, lang, {
          [displayKey]: result.displayName,
          taskName: result.taskName || t("raid-task.unnamedTaskFallback", lang),
        }),
        tip: t(`raid-task.${noticePrefix}.successTip`, lang),
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
