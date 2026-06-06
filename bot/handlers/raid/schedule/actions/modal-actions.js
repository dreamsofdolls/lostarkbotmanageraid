"use strict";

const { t } = require("../../../../services/i18n");
const { parseStartTime } = require("../../../../services/raid/schedule/time-parse");

function createScheduleModalActions({
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  clip,
  ephemeralFlag,
  boardLang,
  loadEvent,
  editBoardMessage,
  rejectUnlessLeadMutable,
  noticePayload,
  noticeEmbed,
}) {
  function modalTextRow(customId, label, { required, value, maxLength = 100 }) {
    const input = new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(clip(label, 45))
      .setStyle(TextInputStyle.Short)
      .setRequired(Boolean(required))
      .setMaxLength(maxLength);
    if (value) input.setValue(String(value).slice(0, maxLength));
    return new ActionRowBuilder().addComponents(input);
  }

  async function awaitScheduleModalSubmit(interaction, modalId) {
    return interaction
      .awaitModalSubmit({
        time: 120000,
        filter: (submit) => submit.customId === modalId && submit.user.id === interaction.user.id,
      })
      .catch(() => null);
  }

  async function handleSetRoom(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    const id = String(event._id);
    const modalId = `rse:roommodal:${id}`;
    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle(clip(t("raid-schedule.modal.roomTitle", lang), 45))
      .addComponents(
        modalTextRow("room", t("raid-schedule.modal.roomNameLabel", lang), {
          required: true,
          value: event.roomName,
        }),
        modalTextRow("password", t("raid-schedule.modal.roomPasswordLabel", lang), {
          required: false,
          value: event.roomPassword,
        })
      );
    await interaction.showModal(modal);

    const submit = await awaitScheduleModalSubmit(interaction, modalId);
    if (!submit) return;

    const roomName = (submit.fields.getTextInputValue("room") || "").trim();
    const password = (submit.fields.getTextInputValue("password") || "").trim();
    const fresh = await loadEvent(id);
    if (!fresh) {
      await submit.reply(noticePayload(lang, "warn", "missingEventTitle", "missingEventDescription"));
      return;
    }
    fresh.roomName = roomName || null;
    fresh.roomPassword = password || null;
    await fresh.save();

    const langForBoard = await boardLang(fresh.guildId);
    await editBoardMessage(submit, fresh, langForBoard);
    await submit.reply({
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.notice.roomSavedTitle", lang),
          t("raid-schedule.notice.roomSavedDescription", lang, { room: roomName })
        ),
      ],
      flags: ephemeralFlag,
    });
  }

  async function handleEditTime(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    const id = String(event._id);
    const modalId = `rse:timemodal:${id}`;
    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle(clip(t("raid-schedule.modal.timeTitle", lang), 45))
      .addComponents(
        modalTextRow("when", t("raid-schedule.modal.timeLabel", lang), { required: true })
      );
    await interaction.showModal(modal);

    const submit = await awaitScheduleModalSubmit(interaction, modalId);
    if (!submit) return;

    const startAt = parseStartTime(submit.fields.getTextInputValue("when"), lang);
    if (!startAt) {
      await submit.reply(noticePayload(lang, "danger", "invalidTimeTitle", "invalidTimeDescription"));
      return;
    }
    const fresh = await loadEvent(id);
    if (!fresh) {
      await submit.reply(noticePayload(lang, "warn", "missingEventTitle", "missingEventDescription"));
      return;
    }
    fresh.startAt = startAt;
    await fresh.save();

    const langForBoard = await boardLang(fresh.guildId);
    await editBoardMessage(submit, fresh, langForBoard);
    await submit.reply({
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.notice.timeSavedTitle", lang),
          t("raid-schedule.notice.timeSavedDescription", lang, {
            rel: `<t:${Math.floor(startAt.getTime() / 1000)}:R>`,
            abs: `<t:${Math.floor(startAt.getTime() / 1000)}:f>`,
          })
        ),
      ],
      flags: ephemeralFlag,
    });
  }

  return {
    awaitScheduleModalSubmit,
    handleEditTime,
    handleSetRoom,
    modalTextRow,
  };
}

module.exports = {
  createScheduleModalActions,
};
