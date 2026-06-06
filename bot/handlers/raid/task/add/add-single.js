"use strict";

const { t, getUserLanguage } = require("../../../../services/i18n");
const { resolveEditableTaskWriteAccess } = require("../write-access");
const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  generateTaskId,
  normalizeName,
  getCharacterDisplayName,
  findCharacterInUser,
  ensureSideTasks,
  countByReset,
} = require("../../../../utils/raid/tasks/side-tasks");

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

  const cap = capForReset(request.reset);
  const currentCount = countByReset(sideTasks, request.reset);
  if (currentCount >= cap) {
    result.outcome = "cap-reached";
    result.dailyCount = countByReset(sideTasks, "daily");
    result.weeklyCount = countByReset(sideTasks, "weekly");
    return false;
  }

  const dupName = sideTasks.some(
    (task) =>
      normalizeName(task?.name) === normalizeName(request.taskName) &&
      task?.reset === request.reset
  );
  if (dupName) {
    result.outcome = "duplicate";
    return false;
  }

  sideTasks.push({
    taskId: generateTaskId(),
    name: request.taskName,
    reset: request.reset,
    completed: false,
    lastResetAt: cycleStartForReset(request.reset, deps),
    createdAt: Date.now(),
  });
  result.dailyCount = countByReset(sideTasks, "daily");
  result.weeklyCount = countByReset(sideTasks, "weekly");
  return true;
}

function cycleLabelForReset(reset, lang) {
  return reset === "daily"
    ? t("raid-task.add.cycleDailyLabel", lang)
    : t("raid-task.add.cycleWeeklyLabel", lang);
}

const ADD_SINGLE_NOTICE_BUILDERS = {
  "no-roster": ({ lang }) => ({
    type: "warn",
    title: t("raid-task.common.noRosterTitle", lang),
    description: t("raid-task.common.noRosterDescription", lang),
  }),
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

function buildAddSingleSaveFailedNotice(lang) {
  return {
    type: "error",
    title: t("raid-task.save.addFailedTitle", lang),
    description: t("raid-task.save.addFailedDescription", lang),
  };
}

function createAddSingleHandler({
  User,
  saveWithRetry,
  dailyResetStartMs,
  weekResetStartMs,
  resolveTaskWriteTarget,
  replyTaskNotice,
  replyViewOnlyShareNotice,
}) {
  return async function handleAddSingle(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const request = readAddSingleRequest(interaction);
    const validationNotice = buildAddSingleValidationNotice(request, lang);
    if (validationNotice) {
      await replyTaskNotice(interaction, validationNotice);
      return;
    }

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName: request.rosterName,
      commandName: "add-single",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;

    const result = createAddSingleResult();
    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId: access.discordId });
        if (
          applyAddSingleToUserDoc(
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
      console.error("[raid-task add] save failed:", error?.message || error);
      await replyTaskNotice(interaction, buildAddSingleSaveFailedNotice(lang));
      return;
    }

    await replyTaskNotice(interaction, buildAddSingleNotice(result, request, lang));
  };
}

module.exports = {
  createAddSingleHandler,
};
