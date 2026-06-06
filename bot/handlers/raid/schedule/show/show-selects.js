"use strict";

function createScheduleShowSelectActions({
  RaidEvent,
  boardLang,
  boardPayload,
  loadEvent,
  editNotice,
  noticePayload,
  turnPlanDashboardPayload,
}) {
  async function deleteMessageById(interaction, channelId, messageId) {
    if (!channelId || !messageId || !interaction.client?.channels) return false;
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      const message = await channel?.messages?.fetch(messageId);
      if (!message) return false;
      await message.delete();
      return true;
    } catch (error) {
      console.warn("[raid-schedule] switch old-delete failed:", error?.message || error);
      return false;
    }
  }

  function isActiveBoard(event) {
    return Boolean(event && (event.status === "open" || event.status === "locked"));
  }

  function isSameGuild(a, b) {
    return String(a?.guildId) === String(b?.guildId);
  }

  function isCreator(event, userId) {
    return String(event?.creatorId) === String(userId);
  }

  function isSameChannel(a, b) {
    return String(a?.channelId) === String(b?.channelId);
  }

  async function handleShowTpSelect(interaction, event, lang) {
    const chosen = await loadEvent(interaction.values?.[0]);
    if (!isActiveBoard(chosen)) {
      await editNotice(interaction, lang, "warn", "missingEventTitle", "missingEventDescription");
      return;
    }
    if (!isCreator(chosen, interaction.user.id) || !isSameGuild(chosen, event)) {
      await editNotice(interaction, lang, "warn", "showpickDeniedTitle", "showpickDeniedDescription");
      return;
    }
    const mine = await RaidEvent.find({
      guildId: chosen.guildId,
      creatorId: chosen.creatorId,
      status: { $in: ["open", "locked"] },
    }).sort({ startAt: 1 });
    const payload = turnPlanDashboardPayload(chosen, mine, lang);
    await interaction.editReply({ embeds: payload.embeds, components: payload.components });
  }

  async function rejectInvalidShowPick({ interaction, event, chosen, lang }) {
    if (!isCreator(event, interaction.user.id)) {
      await interaction.followUp(noticePayload(lang, "warn", "showpickDeniedTitle", "showpickDeniedDescription"));
      return true;
    }
    if (!isActiveBoard(chosen) || !isSameGuild(chosen, event) || !isSameChannel(chosen, event)) {
      await interaction.followUp(noticePayload(lang, "warn", "missingEventTitle", "missingEventDescription"));
      return true;
    }
    if (!isCreator(chosen, interaction.user.id)) {
      await interaction.followUp(noticePayload(lang, "warn", "showpickDeniedTitle", "showpickDeniedDescription"));
      return true;
    }
    return false;
  }

  async function saveCurrentDetach(event, currentMessageId, lang, interaction) {
    const previousEventMessageId = event.messageId;
    event.messageId = null;
    try {
      await event.save();
      return { ok: true, previousEventMessageId };
    } catch (error) {
      console.warn("[raid-schedule] switch current save failed:", error?.message || error);
      await interaction.followUp(noticePayload(lang, "danger", "resurfaceFailedTitle", "resurfaceFailedDescription"));
      return { ok: false, previousEventMessageId, currentMessageId };
    }
  }

  async function saveChosenAttach({ event, chosen, currentMessageId, previousEventMessageId, lang, interaction }) {
    const previousChosenMessageId = chosen.messageId;
    chosen.messageId = currentMessageId;
    try {
      await chosen.save();
      return { ok: true, previousChosenMessageId };
    } catch (error) {
      console.warn("[raid-schedule] switch chosen save failed:", error?.message || error);
      event.messageId = previousEventMessageId;
      await event.save().catch((rollbackError) => {
        console.warn("[raid-schedule] switch rollback current failed:", rollbackError?.message || rollbackError);
      });
      await interaction.followUp(noticePayload(lang, "danger", "resurfaceFailedTitle", "resurfaceFailedDescription"));
      return { ok: false, previousChosenMessageId };
    }
  }

  async function editVisibleBoard({ interaction, event, chosen, langForBoard, previousEventMessageId, previousChosenMessageId, lang }) {
    try {
      await interaction.editReply(await boardPayload(chosen, langForBoard));
      return true;
    } catch (error) {
      console.warn("[raid-schedule] switch message edit failed:", error?.message || error);
      event.messageId = previousEventMessageId;
      chosen.messageId = previousChosenMessageId;
      await event.save().catch((rollbackError) => {
        console.warn("[raid-schedule] switch rollback current failed:", rollbackError?.message || rollbackError);
      });
      await chosen.save().catch((rollbackError) => {
        console.warn("[raid-schedule] switch rollback chosen failed:", rollbackError?.message || rollbackError);
      });
      await interaction.followUp(noticePayload(lang, "danger", "resurfaceFailedTitle", "resurfaceFailedDescription"));
      return false;
    }
  }

  async function switchVisibleBoard({ interaction, event, chosen, currentMessageId, lang, langForBoard }) {
    const detach = await saveCurrentDetach(event, currentMessageId, lang, interaction);
    if (!detach.ok) return;

    const attach = await saveChosenAttach({
      event,
      chosen,
      currentMessageId,
      previousEventMessageId: detach.previousEventMessageId,
      lang,
      interaction,
    });
    if (!attach.ok) return;

    const edited = await editVisibleBoard({
      interaction,
      event,
      chosen,
      langForBoard,
      previousEventMessageId: detach.previousEventMessageId,
      previousChosenMessageId: attach.previousChosenMessageId,
      lang,
    });
    if (!edited) return;

    if (attach.previousChosenMessageId && String(attach.previousChosenMessageId) !== String(currentMessageId)) {
      await deleteMessageById(interaction, chosen.channelId, attach.previousChosenMessageId);
    }
  }

  async function handleShowPickSelect(interaction, event, lang) {
    const chosen = await loadEvent(interaction.values?.[0]);
    if (await rejectInvalidShowPick({ interaction, event, chosen, lang })) return;

    const currentMessageId = interaction.message?.id || event.messageId;
    if (!currentMessageId) {
      await interaction.followUp(noticePayload(lang, "danger", "resurfaceFailedTitle", "resurfaceFailedDescription"));
      return;
    }

    const langForBoard = await boardLang(chosen.guildId);
    if (String(chosen._id) === String(event._id)) {
      await interaction.editReply(await boardPayload(chosen, langForBoard));
      return;
    }

    await switchVisibleBoard({ interaction, event, chosen, currentMessageId, lang, langForBoard });
  }

  return {
    handleShowPickSelect,
    handleShowTpSelect,
    _private: {
      deleteMessageById,
      isActiveBoard,
      isSameGuild,
      isSameChannel,
      isCreator,
    },
  };
}

module.exports = {
  createScheduleShowSelectActions,
};
