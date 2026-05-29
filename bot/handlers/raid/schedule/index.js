/**
 * handlers/raid/schedule/index.js
 * Live interaction layer for /raid-schedule. The pure schedule services own
 * slot math, RSVP mutation, and auto-clear target selection; this file only
 * bridges them to Discord interactions and persisted RaidEvent documents.
 */

"use strict";

const { t, getUserLanguage, getGuildLanguage } = require("../../../services/i18n");
const {
  RAID_REQUIREMENTS,
  getRaidRequirementMap,
  getGatesForRaid,
  getRaidPartySize,
} = require("../../../domain/raid-catalog");
const { slotCountsForSize } = require("../../../services/raid/schedule/slot-config");
const { parseStartTime } = require("../../../services/raid/schedule/time-parse");
const { listEligibleCharacters } = require("../../../services/raid/schedule/eligibility");
const { applyJoin, applyRsvp } = require("../../../services/raid/schedule/signup-state");
const { assignSlots, detectPromotion } = require("../../../services/raid/schedule/slots");
const { selectAutoClearTargets } = require("../../../services/raid/schedule/auto-clear");
const { buildScheduleEmbed, buildScheduleComponents } = require("./board");

const EPHEMERAL_FLAG = 1 << 6;
const PICKER_LIMIT = 25;

function createRaidScheduleCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  UI,
  User,
  GuildConfig,
  RaidEvent,
  isManagerId,
  applyRaidSetBatchForDiscordId,
}) {
  const ephemeralFlag = MessageFlags?.Ephemeral ?? EPHEMERAL_FLAG;

  function noticeEmbed(type, title, description) {
    const color = type === "danger"
      ? UI.colors.danger
      : type === "success"
        ? UI.colors.success
        : type === "warn"
          ? UI.colors.progress
          : UI.colors.neutral;
    const embed = new EmbedBuilder().setColor(color).setTitle(title);
    if (description) embed.setDescription(description);
    return embed;
  }

  function noticePayload(lang, type, titleKey, descriptionKey, vars = {}) {
    return {
      embeds: [
        noticeEmbed(
          type,
          t(`raid-schedule.notice.${titleKey}`, lang, vars),
          descriptionKey ? t(`raid-schedule.notice.${descriptionKey}`, lang, vars) : "",
        ),
      ],
      flags: ephemeralFlag,
    };
  }

  async function replyNotice(interaction, lang, type, titleKey, descriptionKey, vars = {}) {
    const payload = noticePayload(lang, type, titleKey, descriptionKey, vars);
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
  }

  async function editNotice(interaction, lang, type, titleKey, descriptionKey, vars = {}) {
    return interaction.editReply({
      embeds: noticePayload(lang, type, titleKey, descriptionKey, vars).embeds,
      components: [],
    });
  }

  async function userLang(interaction) {
    return getUserLanguage(interaction.user?.id, { UserModel: User });
  }

  async function boardLang(guildId) {
    return getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
  }

  function boardPayload(event, lang) {
    return {
      embeds: [buildScheduleEmbed(event, { EmbedBuilder, UI, lang })],
      components: buildScheduleComponents(event, {
        ActionRowBuilder,
        ButtonBuilder,
        ButtonStyle,
        lang,
      }),
    };
  }

  function parseCustomId(customId) {
    const parts = String(customId || "").split(":");
    if (parts[0] !== "rse" || parts.length < 3) return null;
    return {
      eventId: parts[parts.length - 1],
      action: parts.slice(1, -1).join(":"),
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

  function markSignups(event, signups) {
    event.signups = signups;
    if (typeof event.markModified === "function") event.markModified("signups");
  }

  function clip(value, max) {
    const text = String(value || "");
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
  }

  function findOwnEligibleRows(userDoc, event) {
    const rows = listEligibleCharacters(userDoc?.accounts || [], {
      raidKey: event.raidKey,
      minItemLevel: event.minItemLevel,
    });
    return rows
      .map((row, index) => ({ ...row, index }))
      .filter((row) => row.eligible);
  }

  function pickerRowFor(event, rows, lang) {
    const options = rows.slice(0, PICKER_LIMIT).map((row) => {
      const roleKey = row.role === "support" ? "support" : "dps";
      const cleared = row.alreadyCleared
        ? ` ${t("raid-schedule.picker.alreadyClearedSuffix", lang)}`
        : "";
      return {
        label: clip(`${row.name} · ${row.className}`, 100),
        value: String(row.index),
        description: clip(
          `${row.accountName} · ${row.itemLevel} · ${t(`raid-schedule.picker.role.${roleKey}`, lang)}${cleared}`,
          100,
        ),
      };
    });

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rse:pick:${event._id}`)
        .setPlaceholder(t("raid-schedule.picker.placeholder", lang))
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options),
    );
  }

  async function editBoardMessage(interaction, event, lang) {
    if (!event.messageId || !event.channelId || !interaction.client?.channels) return false;
    try {
      const channel = await interaction.client.channels.fetch(event.channelId);
      const message = await channel?.messages?.fetch(event.messageId);
      if (!message) return false;
      await message.edit(boardPayload(event, lang));
      return true;
    } catch (error) {
      console.warn("[raid-schedule] board edit failed:", error?.message || error);
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
        console.warn("[raid-schedule] auto-clear write failed:", error?.message || error);
      }
    }
    return { targets: targets.length, updated, failed };
  }

  async function handleRaidScheduleCommand(interaction) {
    const lang = await userLang(interaction);
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "notManagerTitle", "notManagerDescription");
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== "create") {
      await replyNotice(interaction, lang, "warn", "unknownTitle", "unknownDescription");
      return;
    }

    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId || interaction.channel?.id;
    if (!guildId || !channelId) {
      await replyNotice(interaction, lang, "danger", "guildOnlyTitle", "guildOnlyDescription");
      return;
    }

    const raidKey = interaction.options.getString("raid", true);
    const modeKey = interaction.options.getString("mode", true);
    const meta = raidMetaFor(raidKey, modeKey);
    if (!meta) {
      await replyNotice(interaction, lang, "danger", "invalidModeTitle", "invalidModeDescription");
      return;
    }

    const startAt = parseStartTime(interaction.options.getString("when", true), lang);
    if (!startAt) {
      await replyNotice(interaction, lang, "danger", "invalidTimeTitle", "invalidTimeDescription");
      return;
    }

    const partySize = getRaidPartySize(raidKey);
    const { supSlots, dpsSlots } = slotCountsForSize(partySize);
    const autoLockAtStart = interaction.options.getBoolean("auto_lock") ?? true;
    const title = (interaction.options.getString("title") || `${meta.label}`).trim();

    await interaction.deferReply();

    const event = new RaidEvent({
      guildId,
      channelId,
      creatorId: interaction.user.id,
      raidKey,
      modeKey,
      minItemLevel: meta.minItemLevel,
      partySize,
      supSlots,
      dpsSlots,
      title,
      startAt,
      autoLockAtStart,
      status: "open",
      signups: [],
    });
    await event.save();

    const langForBoard = await boardLang(guildId);
    const message = await interaction.editReply(boardPayload(event, langForBoard));
    const savedMessage = message?.id ? message : await interaction.fetchReply();
    event.messageId = savedMessage?.id || null;
    await event.save();
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

    const rows = findOwnEligibleRows(userDoc, event);
    if (rows.length === 0) {
      await editNotice(interaction, lang, "warn", "noEligibleTitle", "noEligibleDescription", {
        ilvl: event.minItemLevel,
      });
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
    const rows = findOwnEligibleRows(userDoc, event);
    const row = rows.find((candidate) => candidate.index === rowIndex);
    if (!row) {
      await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
      return;
    }

    const before = Array.from(event.signups || []);
    const next = applyJoin(before, {
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
    if (event.status === "cleared" || event.status === "cancelled") {
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
    await interaction.editReply(boardPayload(event, langForBoard));

    const promoted = detectPromotion(before, result.signups, {
      supSlots: event.supSlots,
      dpsSlots: event.dpsSlots,
    });
    if (promoted.length > 0) {
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

  async function handleLockToggle(interaction, event, action, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    event.status = action === "unlock" ? "open" : "locked";
    await interaction.deferUpdate();
    await event.save();
    const langForBoard = await boardLang(event.guildId);
    await interaction.editReply(boardPayload(event, langForBoard));
  }

  async function handleEnd(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }

    await interaction.deferUpdate();
    const summary = await writeAutoClears(interaction, event);
    event.status = "cleared";
    event.clearedAt = new Date();
    await event.save();

    const langForBoard = await boardLang(event.guildId);
    await interaction.editReply(boardPayload(event, langForBoard));
    await interaction.followUp({
      embeds: [
        noticeEmbed(
          summary.failed > 0 ? "warn" : "success",
          t("raid-schedule.notice.endedTitle", lang, summary),
          t("raid-schedule.notice.endedDescription", lang, summary),
        ),
      ],
      flags: ephemeralFlag,
    }).catch(() => {});
  }

  async function handleRoom(interaction, event, lang) {
    if (!isCompMember(event, interaction.user.id)) {
      await replyNotice(interaction, lang, "warn", "roomDeniedTitle", "roomDeniedDescription");
      return;
    }
    if (!event.roomName) {
      await replyNotice(interaction, lang, "info", "roomEmptyTitle", "roomEmptyDescription");
      return;
    }
    const passwordLine = event.roomPassword
      ? t("raid-schedule.notice.roomPasswordLine", lang, { password: event.roomPassword })
      : t("raid-schedule.notice.roomNoPasswordLine", lang);
    await interaction.reply({
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.roomTitle", lang),
          t("raid-schedule.notice.roomDescription", lang, {
            room: event.roomName,
            passwordLine,
          }),
        ),
      ],
      flags: ephemeralFlag,
    });
  }

  async function handleHelp(interaction, lang) {
    await interaction.reply({
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.helpTitle", lang),
          t("raid-schedule.notice.helpDescription", lang),
        ),
      ],
      flags: ephemeralFlag,
    });
  }

  async function handleRaidScheduleButton(interaction) {
    const lang = await userLang(interaction);
    const parsed = parseCustomId(interaction.customId);
    const event = parsed ? await loadEvent(parsed.eventId) : null;
    if (!event) {
      await replyNotice(interaction, lang, "warn", "missingEventTitle", "missingEventDescription");
      return;
    }

    if (parsed.action === "join") return handleJoin(interaction, event, lang);
    if (parsed.action.startsWith("rsvp:")) {
      return handleRsvp(interaction, event, parsed.action.slice("rsvp:".length), lang);
    }
    if (parsed.action === "lock" || parsed.action === "unlock") {
      return handleLockToggle(interaction, event, parsed.action, lang);
    }
    if (parsed.action === "end") return handleEnd(interaction, event, lang);
    if (parsed.action === "room") return handleRoom(interaction, event, lang);
    if (parsed.action === "help") return handleHelp(interaction, lang);
    if (parsed.action === "manage") {
      await replyNotice(interaction, lang, "info", "manageTitle", "manageDescription");
      return;
    }
    await replyNotice(interaction, lang, "warn", "unknownTitle", "unknownDescription");
  }

  async function handleRaidScheduleSelect(interaction) {
    const parsed = parseCustomId(interaction.customId);
    await interaction.deferUpdate();
    const lang = await userLang(interaction);
    const event = parsed && parsed.action === "pick" ? await loadEvent(parsed.eventId) : null;
    if (!event) {
      await editNotice(interaction, lang, "warn", "missingEventTitle", "missingEventDescription");
      return;
    }
    await handlePick(interaction, event, lang);
  }

  return {
    handleRaidScheduleCommand,
    handleRaidScheduleButton,
    handleRaidScheduleSelect,
  };
}

module.exports = {
  createRaidScheduleCommand,
  RAID_REQUIREMENTS,
};
