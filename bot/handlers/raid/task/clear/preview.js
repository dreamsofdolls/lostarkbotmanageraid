"use strict";

const { t, getUserLanguage } = require("../../../../services/i18n");
const { resolveEditableTaskWriteAccess } = require("../write-access");
const {
  getCharacterDisplayName,
  findCharacterInUser,
  countByReset,
} = require("../../../../utils/raid/tasks/side-tasks");
const { buildClearConfirmRow } = require("./components");

function buildClearPreviewNotice(found, characterName, lang) {
  if (!found) {
    return {
      type: "warn",
      title: t("raid-task.common.noCharacterTitle", lang),
      description: t("raid-task.common.noCharacterDescription", lang, {
        characterName,
      }),
    };
  }

  const resolvedCharName = getCharacterDisplayName(found.character);
  const sideTasks = Array.isArray(found.character.sideTasks)
    ? found.character.sideTasks
    : [];
  if (sideTasks.length === 0) {
    return {
      type: "info",
      title: t("raid-task.clear.nothingTitle", lang),
      description: t("raid-task.clear.nothingDescription", lang, {
        characterName: resolvedCharName,
      }),
    };
  }

  return {
    type: "warn",
    title: t("raid-task.clear.confirmTitle", lang),
    description: t("raid-task.clear.confirmDescription", lang, {
      taskCount: sideTasks.length,
      characterName: resolvedCharName,
      dailyCount: countByReset(sideTasks, "daily"),
      weeklyCount: countByReset(sideTasks, "weekly"),
    }),
  };
}

function createClearPreviewHandler({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  User,
  resolveTaskWriteTarget,
  replyTaskNotice,
  replyViewOnlyShareNotice,
}) {
  return async function handleClear(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const characterName = interaction.options.getString("character", true);

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName,
      commandName: "clear",
      logKind: "share-preview",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => replyViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;

    const userDoc = await User.findOne({ discordId: access.discordId }).lean();
    const found = userDoc
      ? findCharacterInUser(userDoc, characterName, rosterName)
      : null;
    const notice = buildClearPreviewNotice(found, characterName, lang);
    if (!found || !Array.isArray(found.character?.sideTasks) || found.character.sideTasks.length === 0) {
      await replyTaskNotice(interaction, notice);
      return;
    }

    const confirmRow = buildClearConfirmRow({
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      resolvedRosterName: found.account.accountName || rosterName,
      resolvedCharName: getCharacterDisplayName(found.character),
      lang,
    });

    await replyTaskNotice(interaction, notice, {
      components: [confirmRow],
    });
  };
}

module.exports = {
  createClearPreviewHandler,
};
