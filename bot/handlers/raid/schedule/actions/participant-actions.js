"use strict";

const { t } = require("../../../../services/i18n");
const { partitionSelectable } = require("../../../../services/raid/schedule/eligibility");
const { applyJoin, applyRsvp } = require("../../../../services/raid/schedule/signup-state");
const { detectPromotion } = require("../../../../services/raid/schedule/slots");
const {
  PICKER_LIMIT,
  findOwnEligibleRows,
  characterSelectOptions,
} = require("../view/select-options");

function createScheduleParticipantActions({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  User,
  ephemeralFlag,
  boardLang,
  boardPayload,
  editBoardMessage,
  isClosedEvent,
  markSignups,
  replyNotice,
  editNotice,
  noticeEmbed,
}) {
  function pickerRowFor(event, rows, lang) {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rse:pick:${event._id}`)
        .setPlaceholder(t("raid-schedule.picker.placeholder", lang))
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(characterSelectOptions(rows, lang)),
    );
  }

  async function handleJoin(interaction, event, lang) {
    if (event.status !== "open") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    await interaction.deferReply({ flags: ephemeralFlag });
    const userDoc = await User.findOne({ discordId: interaction.user.id }).lean();
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      await editNotice(interaction, lang, "warn", "noRosterTitle", "noRosterDescription");
      return;
    }

    const { selectable: rows, allCleared } = partitionSelectable(findOwnEligibleRows(userDoc, event));
    if (rows.length === 0) {
      await editNotice(
        interaction,
        lang,
        "warn",
        allCleared ? "allClearedTitle" : "noEligibleTitle",
        allCleared ? "allClearedDescription" : "noEligibleDescription",
        { ilvl: event.minItemLevel },
      );
      return;
    }

    const descriptionKey = rows.length > PICKER_LIMIT
      ? "pickerDescriptionLimited"
      : "pickerDescription";
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.picker.title", lang),
          t(`raid-schedule.picker.${descriptionKey}`, lang, {
            count: rows.length,
            limit: PICKER_LIMIT,
          }),
        ),
      ],
      components: [pickerRowFor(event, rows, lang)],
    });
  }

  async function handlePick(interaction, event, lang) {
    if (event.status !== "open") {
      await editNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }

    const rowIndex = Number(interaction.values?.[0]);
    const userDoc = await User.findOne({ discordId: interaction.user.id }).lean();
    const rows = partitionSelectable(findOwnEligibleRows(userDoc, event)).selectable;
    const row = rows.find((candidate) => candidate.index === rowIndex);
    if (!row) {
      await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
      return;
    }

    const next = applyJoin(Array.from(event.signups || []), {
      discordId: interaction.user.id,
      accountName: row.accountName,
      characterName: row.name,
      characterClass: row.className,
      characterItemLevel: row.itemLevel,
      alreadyClearedThisWeek: row.alreadyCleared,
    });
    markSignups(event, next);
    await event.save();

    const langForBoard = await boardLang(event.guildId);
    const refreshed = await editBoardMessage(interaction, event, langForBoard);
    await editNotice(
      interaction,
      lang,
      refreshed ? "success" : "warn",
      refreshed ? "joinedTitle" : "joinedRefreshFailedTitle",
      refreshed ? "joinedDescription" : "joinedRefreshFailedDescription",
      { character: row.name },
    );
  }

  async function handleRsvp(interaction, event, status, lang) {
    if (isClosedEvent(event)) {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    if (event.status === "locked" && status !== "absent") {
      await replyNotice(interaction, lang, "warn", "lockedTitle", "lockedDescription");
      return;
    }

    const before = Array.from(event.signups || []);
    const result = applyRsvp(before, interaction.user.id, status);
    if (!result.ok) {
      await replyNotice(interaction, lang, "warn", "notJoinedTitle", "notJoinedDescription");
      return;
    }

    markSignups(event, result.signups);
    await interaction.deferUpdate();
    await event.save();
    const langForBoard = await boardLang(event.guildId);
    await interaction.editReply(await boardPayload(event, langForBoard));

    const promoted = detectPromotion(before, result.signups, {
      supSlots: event.supSlots,
      dpsSlots: event.dpsSlots,
    });
    if (promoted.length > 0 && !event.skipNotify) {
      await interaction.followUp({
        content: promoted
          .map((s) => t("raid-schedule.notice.promotedPing", langForBoard, {
            user: `<@${s.discordId}>`,
            character: s.characterName,
          }))
          .join("\n"),
        flags: ephemeralFlag,
      }).catch(() => {});
    }
  }

  return {
    handleJoin,
    handlePick,
    handleRsvp,
  };
}

module.exports = {
  createScheduleParticipantActions,
};
