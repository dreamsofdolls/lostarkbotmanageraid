"use strict";

// tPick, not t: some titles here are variant pools; non-pool keys pass through.
const { tPick: t } = require("../../../../services/i18n");
const { createTaskMutationHandler } = require("../write-handler");
const {
  findAccountInUser,
  getCharacterDisplayName,
  ensureSideTasks,
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
  buildChunkedFields,
  buildRosterNotFoundNotice,
  formatCharacterLabel,
  getCharacterClass,
} = require("../../../../utils/raid/common/shared");
const { hasRosterAccounts } = require("../../../../utils/user-doc");

function readAddAllRequest(interaction) {
  return {
    rosterName: interaction.options.getString("roster", true),
    taskName: interaction.options.getString("name", true).trim(),
    reset: interaction.options.getString("reset", true),
  };
}

function buildAddAllValidationNotice(request, lang) {
  return request.taskName ? null : invalidTaskNameNotice(lang);
}

function createAddAllResult(rosterName) {
  return {
    outcome: "ok",
    resolvedRosterName: rosterName,
    added: [],
    skippedCap: [],
    skippedDup: [],
  };
}

const RESULT_LIST_BY_OUTCOME = Object.freeze({
  added: "added",
  "cap-reached": "skippedCap",
  duplicate: "skippedDup",
});

function applyAddAllToCharacter(character, request, result, cycleStart) {
  const outcome = tryAddSideTask(ensureSideTasks(character), request, cycleStart);
  result[RESULT_LIST_BY_OUTCOME[outcome]].push(
    formatCharacterLabel(getCharacterDisplayName(character), getCharacterClass(character)),
  );
}

function applyAddAllToUserDoc(userDoc, request, result, deps) {
  if (!hasRosterAccounts(userDoc)) {
    result.outcome = "no-roster";
    return false;
  }

  const account = findAccountInUser(userDoc, request.rosterName);
  if (!account) {
    result.outcome = "no-roster-match";
    return false;
  }

  result.resolvedRosterName = account.accountName;
  const characters = Array.isArray(account.characters) ? account.characters : [];
  if (characters.length === 0) {
    result.outcome = "empty-roster";
    return false;
  }

  const cycleStart = cycleStartForReset(request.reset, deps);
  for (const character of characters) {
    applyAddAllToCharacter(character, request, result, cycleStart);
  }

  return result.added.length > 0;
}

function skippedLines(names, reason, lang) {
  return names
    .map((charName) =>
      t("raid-task.addAll.skippedLine", lang, { charName, reason }),
    )
    .join("\n");
}

function buildSkippedField(result, request, lang) {
  const lines = [];
  if (result.skippedDup.length > 0) {
    lines.push(skippedLines(result.skippedDup, t("raid-task.addAll.skippedReasonDup", lang), lang));
  }
  if (result.skippedCap.length > 0) {
    const reasonCap = t("raid-task.addAll.skippedReasonCap", lang, {
      cap: capForReset(request.reset),
      reset: request.reset,
    });
    lines.push(skippedLines(result.skippedCap, reasonCap, lang));
  }
  if (lines.length === 0) return [];
  return buildChunkedFields(t("raid-task.fields.skipped", lang), lines.join("\n"));
}

// Comma-separated names packed into lines that each fit one field, so a
// split between fields never cuts a name from its class icon.
function packNameLines(names, maxLength = 900) {
  const lines = [];
  for (const name of names) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + name.length + 2 <= maxLength) lines[last] += `, ${name}`;
    else lines.push(name);
  }
  return lines.join(",\n");
}

function buildCycleField(request, lang) {
  return { name: t("raid-task.fields.cycle", lang), value: cycleLabelForReset(request.reset, lang), inline: true };
}

function buildAddedFields(result, lang) {
  const totalChars = result.added.length + result.skippedCap.length + result.skippedDup.length;
  return buildChunkedFields(
    t("raid-task.fields.added", lang),
    `${result.added.length}/${totalChars}\n${packNameLines(result.added)}`,
  );
}

function buildAddAllCompletedNotice(result, request, lang) {
  return {
    kind: NoticeKind.DONE,
    title: t("raid-task.addAll.successTitle", lang),
    description: t("raid-task.addAll.successDescription", lang, {
      rosterName: result.resolvedRosterName,
      taskName: request.taskName,
    }),
    fields: [
      buildCycleField(request, lang),
      ...buildAddedFields(result, lang),
      ...buildSkippedField(result, request, lang),
    ],
    tip: t("raid-task.addAll.successTip", lang),
  };
}

function buildAddAllNoMatchNotice(result, request, lang) {
  return {
    kind: NoticeKind.INPUT,
    title: t("raid-task.addAll.noMatchTitle", lang),
    description: t("raid-task.addAll.noMatchDescription", lang, {
      rosterName: result.resolvedRosterName,
      taskName: request.taskName,
    }),
    fields: [buildCycleField(request, lang), ...buildSkippedField(result, request, lang)],
    tip: t("raid-task.addAll.noMatchTip", lang),
  };
}

const ADD_ALL_NOTICE_BUILDERS = {
  "no-roster": ({ lang }) => noRosterNotice(lang),
  "no-roster-match": ({ request, lang }) => buildRosterNotFoundNotice(request.rosterName, lang),
  "empty-roster": ({ result, lang }) => ({
    kind: NoticeKind.EMPTY,
    title: t("raid-task.addAll.emptyRosterTitle", lang),
    description: t("raid-task.addAll.emptyRosterDescription", lang, {
      rosterName: result.resolvedRosterName,
    }),
    tip: t("raid-task.addAll.emptyRosterTip", lang),
  }),
};

/**
 * Notice for one /raid-task add (whole roster) outcome.
 * @param {{outcome: string, resolvedRosterName: string, added: string[], skippedCap: string[], skippedDup: string[]}} result
 *   added and skipped lists hold character labels from formatCharacterLabel
 * @param {{rosterName: string, taskName: string, reset: string}} request
 * @param {string} lang
 * @returns {object} notice options for buildNoticeEmbed
 */
function buildAddAllNotice(result, request, lang) {
  const builder = ADD_ALL_NOTICE_BUILDERS[result.outcome];
  if (builder) return builder({ result, request, lang });
  if (result.added.length === 0) return buildAddAllNoMatchNotice(result, request, lang);
  return buildAddAllCompletedNotice(result, request, lang);
}

function createAddAllHandler(deps) {
  return createTaskMutationHandler(deps, {
    commandName: "add-all",
    readRequest: readAddAllRequest,
    buildValidationNotice: buildAddAllValidationNotice,
    createResult: createAddAllResult,
    applyToUserDoc: applyAddAllToUserDoc,
    buildNotice: buildAddAllNotice,
    saveFailedDescriptionKey: "raid-task.save.addAllFailedDescription",
  });
}

module.exports = { buildAddAllNotice, createAddAllHandler };
