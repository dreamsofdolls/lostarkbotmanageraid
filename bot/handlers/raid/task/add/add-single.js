"use strict";

// tPick, not t: some titles here are variant pools; non-pool keys pass through.
const { tPick: t } = require("../../../../services/i18n");
const { createTaskMutationHandler } = require("../write-handler");
const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  getCharacterDisplayName,
  findCharacterInUser,
  ensureSideTasks,
  countByReset,
} = require("../../../../utils/raid/tasks/side-tasks");
const {
  capForReset,
  cycleStartForReset,
} = require("./reset-policy");
const {
  tryAddSideTask,
  cycleLabelForReset,
  invalidTaskNameNotice,
  noRosterNotice,
} = require("./add-common");

function readAddSingleRequest(interaction) {
  return {
    rosterName: interaction.options.getString("roster", true),
    characterName: interaction.options.getString("character", false),
    taskName: interaction.options.getString("name", true).trim(),
    reset: interaction.options.getString("reset", true),
  };
}

function buildAddSingleValidationNotice(request, lang) {
  if (!request.characterName) {
    return {
      type: "warn",
      title: t("raid-task.common.missingCharacterTitle", lang),
      description: t("raid-task.common.missingCharacterDescription", lang),
    };
  }

  if (!request.taskName) return invalidTaskNameNotice(lang);

  return null;
}

function createAddSingleResult() {
  return {
    outcome: "added",
    resolvedCharName: "",
    dailyCount: 0,
    weeklyCount: 0,
  };
}

function applyAddSingleToUserDoc(userDoc, request, result, deps) {
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    result.outcome = "no-roster";
    return false;
  }

  const found = findCharacterInUser(userDoc, request.characterName, request.rosterName);
  if (!found) {
    result.outcome = "no-character";
    return false;
  }

  const character = found.character;
  const sideTasks = ensureSideTasks(character);
  result.resolvedCharName = getCharacterDisplayName(character);

  const outcome = tryAddSideTask(sideTasks, request, cycleStartForReset(request.reset, deps));
  if (outcome === "duplicate") {
    result.outcome = "duplicate";
    return false;
  }
  result.dailyCount = countByReset(sideTasks, "daily");
  result.weeklyCount = countByReset(sideTasks, "weekly");
  if (outcome === "cap-reached") {
    result.outcome = "cap-reached";
    return false;
  }
  return true;
}

const ADD_SINGLE_NOTICE_BUILDERS = {
  "no-roster": ({ lang }) => noRosterNotice(lang),
  "no-character": ({ request, lang }) => ({
    type: "warn",
    title: t("raid-task.common.noCharacterTitle", lang),
    description: t("raid-task.common.noCharacterDescription", lang, {
      characterName: request.characterName,
    }),
  }),
  "cap-reached": ({ result, request, lang }) => ({
    type: "warn",
    title: t("raid-task.add.capReachedTitle", lang),
    description: t("raid-task.add.capReachedDescription", lang, {
      characterName: result.resolvedCharName,
      cap: capForReset(request.reset),
      reset: request.reset,
      dailyCount: result.dailyCount,
      weeklyCount: result.weeklyCount,
      capDaily: TASK_CAP_DAILY,
      capWeekly: TASK_CAP_WEEKLY,
    }),
  }),
  duplicate: ({ result, request, lang }) => ({
    type: "info",
    title: t("raid-task.add.duplicateTitle", lang),
    description: t("raid-task.add.duplicateDescription", lang, {
      characterName: result.resolvedCharName,
      taskName: request.taskName,
      reset: request.reset,
    }),
  }),
  added: ({ result, request, lang }) => ({
    type: "success",
    title: t("raid-task.add.successTitle", lang),
    description: t("raid-task.add.successDescription", lang, {
      characterName: result.resolvedCharName,
      taskName: request.taskName,
      cycleLabel: cycleLabelForReset(request.reset, lang),
      remainDaily: TASK_CAP_DAILY - result.dailyCount,
      remainWeekly: TASK_CAP_WEEKLY - result.weeklyCount,
    }),
  }),
};

function buildAddSingleNotice(result, request, lang) {
  const builder = ADD_SINGLE_NOTICE_BUILDERS[result.outcome] || ADD_SINGLE_NOTICE_BUILDERS.added;
  return builder({ result, request, lang });
}

function createAddSingleHandler(deps) {
  return createTaskMutationHandler(deps, {
    commandName: "add-single",
    readRequest: readAddSingleRequest,
    buildValidationNotice: buildAddSingleValidationNotice,
    createResult: createAddSingleResult,
    applyToUserDoc: applyAddSingleToUserDoc,
    buildNotice: buildAddSingleNotice,
    saveFailedDescriptionKey: "raid-task.save.addFailedDescription",
  });
}

module.exports = { createAddSingleHandler };
