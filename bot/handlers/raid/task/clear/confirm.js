"use strict";

const { t, getUserLanguage } = require("../../../../services/i18n");
const { resolveEditableTaskWriteAccess } = require("../write-access");
const {
  getCharacterDisplayName,
  findCharacterInUser,
  ensureSideTasks,
  countByReset,
} = require("../../../../utils/raid/tasks/side-tasks");

function createClearResult(characterName) {
  return {
    outcome: "cleared",
    resolvedCharName: characterName,
    removedCount: 0,
    removedDailyCount: 0,
    removedWeeklyCount: 0,
  };
}

function applyClearConfirmed(userDoc, route, result) {
  if (!userDoc) {
    result.outcome = "no-roster";
    return false;
  }

  const found = findCharacterInUser(
    userDoc,
    route.characterName,
    route.hasRoster ? route.rosterName : null
  );
  if (!found) {
    result.outcome = "no-character";
    return false;
  }

  result.resolvedCharName = getCharacterDisplayName(found.character);
  const sideTasks = ensureSideTasks(found.character);
  result.removedCount = sideTasks.length;
  result.removedDailyCount = countByReset(sideTasks, "daily");
  result.removedWeeklyCount = countByReset(sideTasks, "weekly");
  found.character.sideTasks = [];
  return true;
}

function buildClearConfirmNotice(result, lang) {
  if (result.outcome === "no-roster" || result.outcome === "no-character") {
    return {
      type: "warn",
      title: t("raid-task.clear.confirmFailedCharacterTitle", lang),
      description: t("raid-task.clear.confirmFailedCharacterDescription", lang),
    };
  }

  return {
    type: "success",
    title: t("raid-task.clear.successTitle", lang),
    description: t("raid-task.clear.successDescription", lang, {
      taskCount: result.removedCount,
      characterName: result.resolvedCharName,
      dailyCount: result.removedDailyCount,
      weeklyCount: result.removedWeeklyCount,
    }),
  };
}

function buildClearSaveFailedNotice(lang) {
  return {
    type: "error",
    title: t("raid-task.save.addFailedTitle", lang),
    description: t("raid-task.save.clearFailedDescription", lang),
  };
}

async function resolveClearConfirmAccess({
  interaction,
  route,
  executorId,
  lang,
  resolveTaskWriteTarget,
  updateTaskNotice,
  viewOnlyShareNotice,
}) {
  if (!route.hasRoster) return { ok: true, discordId: executorId };
  return resolveEditableTaskWriteAccess({
    executorId,
    rosterName: route.rosterName,
    commandName: "clear-confirm",
    resolveTaskWriteTarget,
    denyViewOnly: (writeTarget) =>
      updateTaskNotice(interaction, viewOnlyShareNotice(writeTarget, lang)),
  });
}

function createClearConfirmHandler({
  User,
  saveWithRetry,
  resolveTaskWriteTarget,
  updateTaskNotice,
  viewOnlyShareNotice,
}) {
  return async function handleClearConfirmButton(interaction, route) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const access = await resolveClearConfirmAccess({
      interaction,
      route,
      executorId,
      lang,
      resolveTaskWriteTarget,
      updateTaskNotice,
      viewOnlyShareNotice,
    });
    if (!access.ok) return;

    const result = createClearResult(route.characterName);
    try {
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId: access.discordId });
        if (applyClearConfirmed(userDoc, route, result)) {
          await userDoc.save();
        }
      });
    } catch (error) {
      console.error("[raid-task clear] save failed:", error?.message || error);
      await updateTaskNotice(interaction, buildClearSaveFailedNotice(lang)).catch(() => {});
      return;
    }

    await updateTaskNotice(interaction, buildClearConfirmNotice(result, lang)).catch(() => {});
  };
}

function createClearCancelHandler({
  User,
  updateTaskNotice,
}) {
  return async function handleClearCancelButton(interaction) {
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await updateTaskNotice(interaction, {
      type: "muted",
      title: t("raid-task.clear.cancelledTitle", lang),
      description: t("raid-task.clear.cancelledDescription", lang),
    }).catch(() => {});
  };
}

module.exports = {
  createClearCancelHandler,
  createClearConfirmHandler,
};
