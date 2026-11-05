"use strict";

const { t, getUserLanguage } = require("../../../../services/i18n");
const {
  NoticeKind,
  deferEphemeralReply,
  formatCharacterLabel,
  getCharacterClass,
} = require("../../../../utils/raid/common/shared");
const { resolveEditableTaskWriteAccess } = require("../write-access");
const {
  getCharacterDisplayName,
  findCharacterInUser,
  countByReset,
} = require("../../../../utils/raid/tasks/side-tasks");
const { buildClearConfirmRow } = require("./components");

/**
 * Notice for /raid-task clear before the confirm click: the character is
 * missing, has nothing to clear, or gets the confirm prompt.
 * @param {{character: object}|null} found - the character lookup
 * @param {string} characterName - the name as typed
 * @param {string} lang
 * @returns {object} notice options for buildNoticeEmbed
 */
function buildClearPreviewNotice(found, characterName, lang) {
  if (!found) {
    return {
      kind: NoticeKind.EMPTY,
      title: t("raid-task.common.noCharacterTitle", lang),
      description: t("raid-task.common.noCharacterDescription", lang, {
        characterName,
      }),
      tip: t("raid-task.common.noCharacterTip", lang),
    };
  }

  const characterLabel = formatCharacterLabel(
    getCharacterDisplayName(found.character),
    getCharacterClass(found.character),
  );
  const sideTasks = Array.isArray(found.character.sideTasks)
    ? found.character.sideTasks
    : [];
  if (sideTasks.length === 0) {
    return {
      kind: NoticeKind.EMPTY,
      title: t("raid-task.clear.nothingTitle", lang),
      description: t("raid-task.clear.nothingDescription", lang, {
        characterName: characterLabel,
      }),
      tip: t("raid-task.clear.nothingTip", lang),
    };
  }

  return {
    kind: NoticeKind.CONFIRM,
    title: t("raid-task.clear.confirmTitle", lang),
    description: t("raid-task.clear.confirmDescription", lang, {
      taskCount: sideTasks.length,
      characterName: characterLabel,
      dailyCount: countByReset(sideTasks, "daily"),
      weeklyCount: countByReset(sideTasks, "weekly"),
    }),
    tip: t("raid-task.clear.confirmTip", lang),
  };
}

function createClearPreviewHandler({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  User,
  resolveTaskWriteTarget,
  editTaskNotice,
  editViewOnlyShareNotice,
}) {
  return async function handleClear(interaction) {
    const executorId = interaction.user.id;
    await deferEphemeralReply(interaction);
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true);
    const characterName = interaction.options.getString("character", true);

    const access = await resolveEditableTaskWriteAccess({
      executorId,
      rosterName,
      commandName: "clear",
      logKind: "share-preview",
      resolveTaskWriteTarget,
      denyViewOnly: (writeTarget) => editViewOnlyShareNotice(interaction, writeTarget, lang),
    });
    if (!access.ok) return;

    const userDoc = await User.findOne({ discordId: access.discordId }).lean();
    const found = userDoc
      ? findCharacterInUser(userDoc, characterName, rosterName)
      : null;
    const notice = buildClearPreviewNotice(found, characterName, lang);
    if (!found || !Array.isArray(found.character?.sideTasks) || found.character.sideTasks.length === 0) {
      await editTaskNotice(interaction, notice);
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

    await editTaskNotice(interaction, notice, {
      components: [confirmRow],
    });
  };
}

module.exports = {
  buildClearPreviewNotice,
  createClearPreviewHandler,
};
