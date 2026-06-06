"use strict";

const { t } = require("../../../../services/i18n");
const { partitionSelectable } = require("../../../../services/raid/schedule/slots/eligibility");
const { applyJoin, applyKick } = require("../../../../services/raid/schedule/slots/signup-state");
const { assignSlots, detectPromotion } = require("../../../../services/raid/schedule/slots/slots");
const { removeMembersFromTurns } = require("../../../../services/raid/schedule/turns");
const { findOwnEligibleRows } = require("../view/select-options");
const { parseScheduleCustomId } = require("../router");

function createScheduleMemberActions({
  User,
  boardLang,
  editBoardMessage,
  rejectUnlessLeadMutable,
  replyNotice,
  editNotice,
  noticeEmbed,
  kickSelectPayload,
  addUserSelectPayload,
  addCharSelectPayload,
  markSignups,
  markTurns,
}) {
  async function handleKick(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    if (!Array.isArray(event.signups) || event.signups.length === 0) {
      await replyNotice(interaction, lang, "warn", "kickEmptyTitle", "kickEmptyDescription");
      return;
    }
    await interaction.reply(kickSelectPayload(event, lang));
  }

  async function handleKickSelect(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang, editNotice)) return;
    const before = Array.from(event.signups || []);
    const { signups: next, removed } = applyKick(before, interaction.values || []);
    if (removed.length === 0) {
      await editNotice(interaction, lang, "warn", "kickNoneTitle", "kickNoneDescription");
      return;
    }

    const removedIds = removed.map((s) => s.discordId);
    markSignups(event, next);
    markTurns(event, removeMembersFromTurns(event.turns, removedIds));
    await event.save();

    const langForBoard = await boardLang(event.guildId);
    await editBoardMessage(interaction, event, langForBoard);
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.notice.kickedTitle", lang),
          t("raid-schedule.notice.kickedDescription", lang, {
            members: removed.map((s) => s.characterName).join(", "),
          }),
        ),
      ],
      components: [],
    });

    const promoted = detectPromotion(before, next, {
      supSlots: event.supSlots,
      dpsSlots: event.dpsSlots,
    });
    if (promoted.length > 0 && !event.skipNotify) {
      try {
        const channel = await interaction.client.channels.fetch(event.channelId);
        await channel?.send?.({
          content: promoted
            .map((s) => t("raid-schedule.notice.promotedPing", langForBoard, {
              user: `<@${s.discordId}>`,
              character: s.characterName,
            }))
            .join("\n"),
        });
      } catch (error) {
        console.warn("[raid-schedule] kick promote ping failed:", error?.message || error);
      }
    }
  }

  async function handleAddMember(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    await interaction.reply(addUserSelectPayload(event, lang));
  }

  async function handleAddUserSelect(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang, editNotice)) return;
    const targetId = interaction.values?.[0];
    if (!targetId) {
      await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
      return;
    }

    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    if (targetUser?.bot) {
      await editNotice(interaction, lang, "warn", "addBotTargetTitle", "addBotTargetDescription");
      return;
    }

    const userDoc = await User.findOne({ discordId: targetId }).lean();
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      await editNotice(interaction, lang, "warn", "addNoRosterTitle", "addNoRosterDescription", {
        user: `<@${targetId}>`,
      });
      return;
    }

    const { selectable: rows, allCleared } = partitionSelectable(findOwnEligibleRows(userDoc, event));
    if (rows.length === 0) {
      await editNotice(
        interaction,
        lang,
        "warn",
        allCleared ? "addAllClearedTitle" : "addNoEligibleTitle",
        allCleared ? "addAllClearedDescription" : "addNoEligibleDescription",
        { user: `<@${targetId}>`, ilvl: event.minItemLevel },
      );
      return;
    }

    const payload = addCharSelectPayload(event, targetId, rows, lang);
    await interaction.editReply({ embeds: payload.embeds, components: payload.components });
  }

  async function handleAddPickSelect(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang, editNotice)) return;
    const parsed = parseScheduleCustomId(interaction.customId);
    const targetId = parsed?.action.split(":")[1];
    if (!targetId) {
      await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
      return;
    }

    const rowIndex = Number(interaction.values?.[0]);
    const userDoc = await User.findOne({ discordId: targetId }).lean();
    const rows = partitionSelectable(findOwnEligibleRows(userDoc, event)).selectable;
    const row = rows.find((candidate) => candidate.index === rowIndex);
    if (!row) {
      await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
      return;
    }

    const next = applyJoin(Array.from(event.signups || []), {
      discordId: targetId,
      accountName: row.accountName,
      characterName: row.name,
      characterClass: row.className,
      characterItemLevel: row.itemLevel,
      alreadyClearedThisWeek: row.alreadyCleared,
    });
    const afterSlots = assignSlots(next, {
      supSlots: event.supSlots,
      dpsSlots: event.dpsSlots,
    });
    const addedInComp = [...afterSlots.support, ...afterSlots.dps]
      .some((s) => String(s.discordId) === String(targetId));
    markSignups(event, next);
    await event.save();

    const langForBoard = await boardLang(event.guildId);
    const leadPlacement = t(
      addedInComp ? "raid-schedule.notice.addedPlacementComp" : "raid-schedule.notice.addedPlacementWaitlist",
      lang,
    );
    const boardPlacement = t(
      addedInComp ? "raid-schedule.notice.addedPlacementComp" : "raid-schedule.notice.addedPlacementWaitlist",
      langForBoard,
    );
    await editBoardMessage(interaction, event, langForBoard);
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.notice.addedTitle", lang),
          t("raid-schedule.notice.addedDescription", lang, {
            user: `<@${targetId}>`,
            character: row.name,
            placement: leadPlacement,
          }),
        ),
      ],
      components: [],
    });

    if (event.skipNotify) return;
    try {
      const channel = await interaction.client.channels.fetch(event.channelId);
      await channel?.send?.({
        content: t("raid-schedule.notice.addedPing", langForBoard, {
          user: `<@${targetId}>`,
          title: event.title || "",
          character: row.name,
          placement: boardPlacement,
          rel: `<t:${Math.floor(new Date(event.startAt).getTime() / 1000)}:R>`,
        }),
      });
    } catch (error) {
      console.warn("[raid-schedule] add-member ping failed:", error?.message || error);
    }
  }

  return {
    handleKick,
    handleKickSelect,
    handleAddMember,
    handleAddUserSelect,
    handleAddPickSelect,
  };
}

module.exports = {
  createScheduleMemberActions,
};
