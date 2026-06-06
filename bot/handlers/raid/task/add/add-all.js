"use strict";

const { t, getUserLanguage } = require("../../../../services/i18n");
const { resolveEditableTaskWriteAccess } = require("../write-access");
const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  generateTaskId,
  normalizeName,
  getCharacterDisplayName,
  ensureSideTasks,
  countByReset,
} = require("../../../../utils/raid/tasks/side-tasks");

function readAddAllRequest(interaction) {
  return {
    rosterName: interaction.options.getString("roster", true),
    taskName: interaction.options.getString("name", true).trim(),
    reset: interaction.options.getString("reset", true),
  };
}

function buildAddAllValidationNotice(request, lang) {
  if (!request.taskName) {
    return {
      type: "warn",
      title: t("raid-task.common.invalidTaskNameTitle", lang),
      description: t("raid-task.common.invalidTaskNameDescription", lang),
    };
  }
  return null;
}

function capForReset(reset) {
  return reset === "daily" ? TASK_CAP_DAILY : TASK_CAP_WEEKLY;
}

function cycleStartForReset(reset, { dailyResetStartMs, weekResetStartMs }) {
  return reset === "daily" ? dailyResetStartMs() : weekResetStartMs();
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

function resetAddAllResult(result, rosterName) {
  result.outcome = "ok";
  result.resolvedRosterName = rosterName;
  result.added.length = 0;
  result.skippedCap.length = 0;
  result.skippedDup.length = 0;
}

function findRosterAccount(userDoc, rosterName) {
  const targetRoster = normalizeName(rosterName);
  return userDoc.accounts.find(
    (candidate) => normalizeName(candidate.accountName) === targetRoster
  );
}

function buildTaskRecord(request, cycleStart) {
  return {
    taskId: generateTaskId(),
    name: request.taskName,
    reset: request.reset,
    completed: false,
    lastResetAt: cycleStart,
    createdAt: Date.now(),
  };
}

function applyAddAllToCharacter(character, request, result, cycleStart) {
  const sideTasks = ensureSideTasks(character);
  const charName = getCharacterDisplayName(character);
  if (countByReset(sideTasks, request.reset) >= capForReset(request.reset)) {
    result.skippedCap.push(charName);
    return;
  }

  const taskNameNormalized = normalizeName(request.taskName);
  const dup = sideTasks.some(
    (task) =>
      normalizeName(task?.name) === taskNameNormalized &&
      task?.reset === request.reset
  );
  if (dup) {
    result.skippedDup.push(charName);
    return;
  }

  sideTasks.push(buildTaskRecord(request, cycleStart));
  result.added.push(charName);
}

function applyAddAllToUserDoc(userDoc, request, result, deps) {
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    result.outcome = "no-roster";
    return false;
  }

  const account = findRosterAccount(userDoc, request.rosterName);
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

function cycleLabelForReset(reset, lang) {
  return reset === "daily"
    ? t("raid-task.add.cycleDailyLabel", lang)
    : t("raid-task.add.cycleWeeklyLabel", lang);
}

function skippedLines(names, reason, lang) {
  return names
    .map((charName) =>
      t("raid-task.addAll.skippedLine", lang, { charName, reason }),
    )
    .join("\n");
}

function buildSkippedSection(result, request, lang) {
  const sections = [];
  if (result.skippedDup.length > 0) {
    const reasonDup = t("raid-task.addAll.skippedReasonDup", lang);
    sections.push(
      "\n\n" +
        t("raid-task.addAll.skippedHeader", lang, { count: result.skippedDup.length }) +
        "\n" +
        skippedLines(result.skippedDup, reasonDup, lang),
    );
  }

  if (result.skippedCap.length > 0) {
    const reasonCap = t("raid-task.addAll.skippedReasonCap", lang, {
      cap: capForReset(request.reset),
      reset: request.reset,
    });
    sections.push(
      "\n\n" +
        t("raid-task.addAll.skippedHeader", lang, { count: result.skippedCap.length }) +
        "\n" +
        skippedLines(result.skippedCap, reasonCap, lang),
    );
  }

  return sections.join("");
}

function buildAddedNames(result) {
  const totalChars = result.added.length + result.skippedCap.length + result.skippedDup.length;
  return `${result.added.length}/${totalChars}` +
    (result.added.length > 0 ? `\n> ${result.added.join(", ")}` : "");
}

function buildAddAllCompletedNotice(result, request, lang) {
  const hasAdded = result.added.length > 0;
  return {
    type: hasAdded ? "success" : "info",
    title: hasAdded
      ? t("raid-task.addAll.successTitle", lang)
      : t("raid-task.addAll.noMatchTitle", lang),
    description: t("raid-task.addAll.successDescription", lang, {
      rosterName: result.resolvedRosterName,
      taskName: request.taskName,
      cycleLabel: cycleLabelForReset(request.reset, lang),
      addedNames: buildAddedNames(result),
      skippedSection: buildSkippedSection(result, request, lang),
    }),
  };
}

const ADD_ALL_NOTICE_BUILDERS = {
  "no-roster": ({ lang }) => ({
    type: "warn",
    title: t("raid-task.common.noRosterTitle", lang),
    description: t("raid-task.common.noRosterDescription", lang),
  }),
  "no-roster-match": ({ request, lang }) => ({
    type: "warn",
    title: t("raid-task.common.rosterNotFoundTitle", lang),
    description: t("raid-task.common.rosterNotFoundDescription", lang, {
      rosterName: request.rosterName,
    }),
  }),
  "empty-roster": ({ result, lang }) => ({
    type: "info",
    title: t("raid-task.addAll.emptyRosterTitle", lang),
    description: t("raid-task.addAll.emptyRosterDescription", lang, {
      rosterName: result.resolvedRosterName,
    }),
  }),
};

function buildAddAllNotice(result, request, lang) {
  const hasNoTouchedChars =
    result.outcome === "ok" &&
    result.added.length === 0 &&
    result.skippedCap.length === 0 &&
    result.skippedDup.length === 0;
  if (hasNoTouchedChars) {
    return {
      type: "info",
      title: t("raid-task.addAll.noMatchTitle", lang),
      description: t("raid-task.addAll.noMatchDescription", lang, {
        rosterName: result.resolvedRosterName,
      }),
    };
  }

  const builder = ADD_ALL_NOTICE_BUILDERS[result.outcome];
  if (builder) return builder({ result, request, lang });
  return buildAddAllCompletedNotice(result, request, lang);
}

function buildAddAllSaveFailedNotice(lang) {
  return {
    type: "error",
    title: t("raid-task.save.addFailedTitle", lang),
    description: t("raid-task.save.addAllFailedDescription", lang),
  };
}

function createAddAllHandler({
  User,
  saveWithRetry,
  dailyResetStartMs,
  weekResetStartMs,
  resolveTaskWriteTarget,
  replyTaskNotice,
  replyViewOnlyShareNotice,
}) {
  return async function handleAddAll(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const request = readAddAllRequest(interaction);
    const validationNotice = buildAddAllValidationNotice(request, lang);
    if (validationNotice) {
      await replyTaskNotice(interaction, validationNotice);
      return;
    }

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName: request.rosterName,
      commandName: "add-all",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;

    const result = createAddAllResult(request.rosterName);
    try {
      await saveWithRetry(async () => {
        resetAddAllResult(result, request.rosterName);
        const userDoc = await User.findOne({ discordId: access.discordId });
        if (
          applyAddAllToUserDoc(
            userDoc,
            request,
            result,
            { dailyResetStartMs, weekResetStartMs }
          )
        ) {
          await userDoc.save();
        }
      });
    } catch (error) {
      console.error("[raid-task add-all] save failed:", error?.message || error);
      await replyTaskNotice(interaction, buildAddAllSaveFailedNotice(lang));
      return;
    }

    await replyTaskNotice(interaction, buildAddAllNotice(result, request, lang));
  };
}

module.exports = {
  createAddAllHandler,
};
