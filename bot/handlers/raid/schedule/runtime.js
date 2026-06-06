"use strict";

const { getUserLanguage, getGuildLanguage } = require("../../../services/i18n");
const {
  getRaidRequirementMap,
  getGatesForRaid,
} = require("../../../domain/raid-catalog");
const { assignSlots } = require("../../../services/raid/schedule/slots/slots");
const { selectAutoClearTargets } = require("../../../services/raid/schedule/lifecycle/auto-clear");
const { shapeOwnedBoardOptions } = require("../../../services/raid/schedule/boards/owned-boards");

const CLOSED_EVENT_STATUSES = new Set(["cleared", "cancelled"]);

function createScheduleRuntimeHelpers({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  UI,
  User,
  GuildConfig,
  RaidEvent,
  isManagerId,
  applyRaidSetBatchForDiscordId,
  buildScheduleEmbed,
  buildScheduleComponents,
  replyNotice,
  logger = console,
}) {
  async function userLang(interaction) {
    return getUserLanguage(interaction.user?.id, { UserModel: User });
  }

  async function boardLang(guildId) {
    return getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
  }

  async function boardPayload(event, lang) {
    let ownedBoardOptions = [];
    try {
      const owned = await RaidEvent.find({
        guildId: event.guildId,
        channelId: event.channelId,
        creatorId: event.creatorId,
        status: { $in: ["open", "locked"] },
      })
        .sort({ startAt: 1 })
        .lean();
      if (owned.length >= 2) {
        ownedBoardOptions = shapeOwnedBoardOptions(owned, String(event._id));
        if (owned.length > ownedBoardOptions.length) {
          logger.warn?.(
            `[raid-schedule] board switcher capped: ${owned.length} owned boards, showing ${ownedBoardOptions.length}`
          );
        }
      }
    } catch (error) {
      logger.warn?.("[raid-schedule] owned-board query failed:", error?.message || error);
    }

    return {
      embeds: [buildScheduleEmbed(event, { EmbedBuilder, UI, lang })],
      components: buildScheduleComponents(event, {
        ActionRowBuilder,
        ButtonBuilder,
        ButtonStyle,
        StringSelectMenuBuilder,
        ownedBoardOptions,
        lang,
      }),
    };
  }

  async function loadEvent(eventId) {
    if (!eventId) return null;
    try {
      return await RaidEvent.findById(eventId);
    } catch {
      return null;
    }
  }

  function raidMetaFor(raidKey, modeKey) {
    return getRaidRequirementMap()[`${raidKey}_${modeKey}`] || null;
  }

  function isLeadActionAllowed(interaction) {
    return Boolean(interaction.user?.id && isManagerId(interaction.user.id));
  }

  function isClosedEvent(event) {
    return CLOSED_EVENT_STATUSES.has(event?.status);
  }

  async function rejectUnlessLead(
    interaction,
    lang,
    respond = replyNotice,
    titleKey = "managerOnlyTitle",
    descriptionKey = "managerOnlyDescription"
  ) {
    if (isLeadActionAllowed(interaction)) return false;
    await respond(interaction, lang, "danger", titleKey, descriptionKey);
    return true;
  }

  async function rejectIfEventClosed(interaction, event, lang, respond = replyNotice) {
    if (!isClosedEvent(event)) return false;
    await respond(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
    return true;
  }

  async function rejectUnlessLeadMutable(interaction, event, lang, respond = replyNotice) {
    if (await rejectUnlessLead(interaction, lang, respond)) return true;
    return rejectIfEventClosed(interaction, event, lang, respond);
  }

  function markSignups(event, signups) {
    event.signups = signups;
    if (typeof event.markModified === "function") event.markModified("signups");
  }

  function markTurns(event, turns) {
    event.turns = turns;
    if (typeof event.markModified === "function") event.markModified("turns");
  }

  async function editBoardMessage(interaction, event, lang) {
    if (!event.messageId || !event.channelId || !interaction.client?.channels) return false;
    try {
      const channel = await interaction.client.channels.fetch(event.channelId);
      const message = await channel?.messages?.fetch(event.messageId);
      if (!message) return false;
      await message.edit(await boardPayload(event, lang));
      return true;
    } catch (error) {
      logger.warn?.("[raid-schedule] board edit failed:", error?.message || error);
      return false;
    }
  }

  function isCompMember(event, discordId) {
    const slots = assignSlots(event.signups, {
      supSlots: event.supSlots,
      dpsSlots: event.dpsSlots,
    });
    return [...slots.support, ...slots.dps].some((s) => s.discordId === discordId);
  }

  async function writeAutoClears(interaction, event) {
    const targets = selectAutoClearTargets(event);
    if (targets.length === 0 || typeof applyRaidSetBatchForDiscordId !== "function") {
      return { targets: targets.length, updated: 0, failed: 0 };
    }

    const raidMeta = raidMetaFor(event.raidKey, event.modeKey);
    const effectiveGates = getGatesForRaid(event.raidKey);
    const byUser = new Map();
    for (const target of targets) {
      const list = byUser.get(target.discordId) || [];
      list.push({
        executorId: interaction.user.id,
        rosterName: target.accountName,
        characterName: target.characterName,
        raidMeta,
        statusType: "complete",
        effectiveGates,
      });
      byUser.set(target.discordId, list);
    }

    let updated = 0;
    let failed = 0;
    for (const [discordId, entries] of byUser.entries()) {
      try {
        const results = await applyRaidSetBatchForDiscordId({ discordId, entries });
        updated += results.filter((r) => r.updated).length;
        failed += results.filter((r) => !r.updated).length;
      } catch (error) {
        failed += entries.length;
        logger.warn?.("[raid-schedule] auto-clear write failed:", error?.message || error);
      }
    }
    return { targets: targets.length, updated, failed };
  }

  function onBoardMessage(interaction, event) {
    return Boolean(
      interaction.message && String(interaction.message.id) === String(event.messageId)
    );
  }

  return {
    boardLang,
    boardPayload,
    editBoardMessage,
    isClosedEvent,
    isCompMember,
    loadEvent,
    markSignups,
    markTurns,
    onBoardMessage,
    raidMetaFor,
    rejectIfEventClosed,
    rejectUnlessLead,
    rejectUnlessLeadMutable,
    userLang,
    writeAutoClears,
  };
}

module.exports = {
  CLOSED_EVENT_STATUSES,
  createScheduleRuntimeHelpers,
};
