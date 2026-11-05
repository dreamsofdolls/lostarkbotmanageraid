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
const {
  NoticeKind,
  formatCharacterLabel,
  getCharacterClass,
} = require("../../../../utils/raid/common/shared");

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
      kind: NoticeKind.INPUT,
      title: t("raid-task.common.missingCharacterTitle", lang),
      description: t("raid-task.common.missingCharacterDescription", lang),
      tip: t("raid-task.common.missingCharacterTip", lang),
    };
  }

  if (!request.taskName) return invalidTaskNameNotice(lang);

  return null;
}

function createAddSingleResult() {
  return {
    outcome: "added",
    resolvedCharName: "",
    resolvedCharClass: "",
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
  result.resolvedCharClass = getCharacterClass(character);

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
    kind: NoticeKind.EMPTY,
    title: t("raid-task.common.noCharacterTitle", lang),
    description: t("raid-task.common.noCharacterDescription", lang, {
      characterName: request.characterName,
    }),
    tip: t("raid-task.common.noCharacterTip", lang),
  }),
  "cap-reached": ({ result, request, lang }) => ({
    kind: NoticeKind.INPUT,
    title: t("raid-task.add.capReachedTitle", lang),
    description: t("raid-task.add.capReachedDescription", lang, {
      characterName: formatCharacterLabel(result.resolvedCharName, result.resolvedCharClass),
      cap: capForReset(request.reset),
      reset: request.reset,
    }),
    fields: [{
      name: t("raid-task.fields.slotsUsed", lang),
      value: t("raid-task.fields.slotsUsedValue", lang, {
        dailyCount: result.dailyCount,
        weeklyCount: result.weeklyCount,
        capDaily: TASK_CAP_DAILY,
        capWeekly: TASK_CAP_WEEKLY,
      }),
      inline: true,
    }],
    tip: t("raid-task.add.capReachedTip", lang),
  }),
  duplicate: ({ result, request, lang }) => ({
    kind: NoticeKind.INPUT,
    title: t("raid-task.add.duplicateTitle", lang),
    description: t("raid-task.add.duplicateDescription", lang, {
      characterName: formatCharacterLabel(result.resolvedCharName, result.resolvedCharClass),
      taskName: request.taskName,
      reset: request.reset,
    }),
    tip: t("raid-task.add.duplicateTip", lang),
  }),
  added: ({ result, request, lang }) => ({
    kind: NoticeKind.DONE,
    title: t("raid-task.add.successTitle", lang),
    description: t("raid-task.add.successDescription", lang, {
      characterName: formatCharacterLabel(result.resolvedCharName, result.resolvedCharClass),
      taskName: request.taskName,
    }),
    fields: [
      { name: t("raid-task.fields.cycle", lang), value: cycleLabelForReset(request.reset, lang), inline: true },
      {
        name: t("raid-task.fields.slotsLeft", lang),
        value: t("raid-task.fields.slotsLeftValue", lang, {
          daily: TASK_CAP_DAILY - result.dailyCount,
          weekly: TASK_CAP_WEEKLY - result.weeklyCount,
        }),
        inline: true,
      },
    ],
    tip: t("raid-task.add.successTip", lang),
  }),
};

/**
 * Notice for one /raid-task add (single character) outcome.
 * @param {{outcome: string, resolvedCharName?: string, resolvedCharClass?: string, dailyCount?: number, weeklyCount?: number}} result
 * @param {{characterName?: string, taskName?: string, reset?: string}} request
 * @param {string} lang
 * @returns {object} notice options for buildNoticeEmbed
 */
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

module.exports = { buildAddSingleNotice, createAddSingleHandler };
