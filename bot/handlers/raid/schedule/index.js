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
const { applyJoin, applyRsvp, applyKick } = require("../../../services/raid/schedule/signup-state");
const { assignSlots, detectPromotion } = require("../../../services/raid/schedule/slots");
const { selectAutoClearTargets } = require("../../../services/raid/schedule/auto-clear");
const {
  addTurn,
  setTurnMembers,
  removeMembersFromTurns,
} = require("../../../services/raid/schedule/turns");
const { buildScheduleEmbed, buildScheduleComponents, buildTurnPlanEmbed } = require("./board");
const { getClassEmoji } = require("../../../models/Class");

const EPHEMERAL_FLAG = 1 << 6;
const PICKER_LIMIT = 25;

function createRaidScheduleCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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

  // Class emojis come from models/Class as `<:name:id>` markup, but a select
  // option's icon lives in a separate `emoji` field that wants the resolved
  // {id, name} shape (the raw string would fail builder validation). Returns
  // null for missing/unbootstrapped classes so the option just shows no icon.
  function classEmojiOption(className) {
    const m = /^<(a)?:(\w+):(\d+)>$/.exec(getClassEmoji(className) || "");
    if (!m) return null;
    return m[1] ? { id: m[3], name: m[2], animated: true } : { id: m[3], name: m[2] };
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
      const emoji = classEmojiOption(row.className);
      // Class is conveyed by the icon now, so the label is just the character
      // name; the role chip (Support/DPS) still lives in the description.
      return {
        label: clip(row.name, 100),
        value: String(row.index),
        description: clip(
          `${row.accountName} · ${row.itemLevel} · ${t(`raid-schedule.picker.role.${roleKey}`, lang)}${cleared}`,
          100,
        ),
        ...(emoji ? { emoji } : {}),
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
    const subcommand = interaction.options.getSubcommand();
    // `show` is a read-only public display, so anyone can run it.
    if (subcommand === "show") return handleShowCommand(interaction);

    const lang = await userLang(interaction);
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "notManagerTitle", "notManagerDescription");
      return;
    }
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
    const onBoard = onBoardMessage(interaction, event);
    event.status = action === "unlock" ? "open" : "locked";
    await interaction.deferUpdate();
    await event.save();
    const langForBoard = await boardLang(event.guildId);
    if (onBoard) {
      await interaction.editReply(boardPayload(event, langForBoard));
      return;
    }
    // From the Manage menu: update the canonical board, then re-render the
    // ephemeral menu so the Lock/Unlock label flips.
    await editBoardMessage(interaction, event, langForBoard);
    const menu = manageMenuPayload(event, lang);
    await interaction.editReply({ embeds: menu.embeds, components: menu.components });
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
    const onBoard = onBoardMessage(interaction, event);
    const summaryEmbed = noticeEmbed(
      summary.failed > 0 ? "warn" : "success",
      t("raid-schedule.notice.endedTitle", lang, summary),
      t("raid-schedule.notice.endedDescription", lang, summary),
    );
    if (onBoard) {
      await interaction.editReply(boardPayload(event, langForBoard));
      await interaction.followUp({ embeds: [summaryEmbed], flags: ephemeralFlag }).catch(() => {});
      return;
    }
    // From the Manage menu: freeze the canonical board, then collapse the
    // ephemeral menu down to the end summary.
    await editBoardMessage(interaction, event, langForBoard);
    await interaction.editReply({ embeds: [summaryEmbed], components: [] });
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

  // Lead-only control panel (ephemeral). Buttons reuse the rse: prefix so
  // they route back through handleRaidScheduleButton. Grouped into 3 rows by
  // purpose so colour follows meaning (the old single 5-button row interleaved
  // grey + red and read as messy): row 1 = event config (all Secondary), row 2
  // = people (Phân turn Primary + Kick Danger), row 3 = terminal actions (both
  // Danger, kept together at the bottom). No shared interaction-router change.
  function manageMenuPayload(event, lang) {
    const id = String(event._id);
    const locked = event.status === "locked";
    const configRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:${locked ? "unlock" : "lock"}:${id}`)
        .setLabel(t(locked ? "raid-schedule.btn.unlock" : "raid-schedule.btn.lock", lang))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`rse:setroom:${id}`)
        .setLabel(t("raid-schedule.btn.setRoom", lang))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`rse:edittime:${id}`)
        .setLabel(t("raid-schedule.btn.editTime", lang))
        .setStyle(ButtonStyle.Secondary),
    );
    const peopleRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:teams:${id}`)
        .setLabel(t("raid-schedule.btn.teams", lang))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`rse:kick:${id}`)
        .setLabel(t("raid-schedule.btn.kick", lang))
        .setStyle(ButtonStyle.Danger),
    );
    const terminalRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:end:${id}`)
        .setLabel(t("raid-schedule.btn.end", lang))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`rse:cancel:${id}`)
        .setLabel(t("raid-schedule.btn.cancelEvent", lang))
        .setStyle(ButtonStyle.Danger),
    );
    return {
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.manageTitle", lang),
          t("raid-schedule.notice.manageDescription", lang),
        ),
      ],
      components: [configRow, peopleRow, terminalRow],
      flags: ephemeralFlag,
    };
  }

  async function handleManage(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    await interaction.reply(manageMenuPayload(event, lang));
  }

  // Lock/unlock + End are reachable from the Manage menu (ephemeral), and
  // from legacy boards that still carry those buttons. `onBoardMessage`
  // distinguishes the two so we edit the right surface: the board in place
  // when clicked on the board, or the canonical board via messageId + the
  // ephemeral menu re-render when clicked from the menu.
  function onBoardMessage(interaction, event) {
    return Boolean(
      interaction.message && String(interaction.message.id) === String(event.messageId),
    );
  }

  // Build a single-line text input row for a modal.
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

  async function handleSetRoom(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
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
        }),
      );
    await interaction.showModal(modal);

    // Promise-based collector instead of router-level modal routing - keeps
    // this flow self-contained (no shared-router change).
    const submit = await interaction
      .awaitModalSubmit({
        time: 120000,
        filter: (i) => i.customId === modalId && i.user.id === interaction.user.id,
      })
      .catch(() => null);
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
          t("raid-schedule.notice.roomSavedDescription", lang, { room: roomName }),
        ),
      ],
      flags: ephemeralFlag,
    });
  }

  async function handleEditTime(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    const id = String(event._id);
    const modalId = `rse:timemodal:${id}`;
    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle(clip(t("raid-schedule.modal.timeTitle", lang), 45))
      .addComponents(
        modalTextRow("when", t("raid-schedule.modal.timeLabel", lang), { required: true }),
      );
    await interaction.showModal(modal);

    const submit = await interaction
      .awaitModalSubmit({
        time: 120000,
        filter: (i) => i.customId === modalId && i.user.id === interaction.user.id,
      })
      .catch(() => null);
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
          }),
        ),
      ],
      flags: ephemeralFlag,
    });
  }

  async function handleCancel(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    await interaction.deferUpdate();
    event.status = "cancelled";
    event.cancelledAt = new Date();
    await event.save();

    const langForBoard = await boardLang(event.guildId);
    await editBoardMessage(interaction, event, langForBoard);
    // Collapse the ephemeral manage menu the button lives on.
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "warn",
          t("raid-schedule.notice.cancelledTitle", lang),
          t("raid-schedule.notice.cancelledDescription", lang),
        ),
      ],
      components: [],
    }).catch(() => {});

    // Ping everyone who signed up, in the public channel (mentions only fire
    // from message content, not embeds · see feedback_discord_embed_mentions).
    const ids = [...new Set((event.signups || []).map((s) => s.discordId))];
    if (ids.length > 0) {
      try {
        const channel = await interaction.client.channels.fetch(event.channelId);
        await channel?.send?.({
          content: t("raid-schedule.notice.cancelPingContent", langForBoard, {
            users: ids.map((id) => `<@${id}>`).join(" "),
            title: event.title || "",
          }),
        });
      } catch (error) {
        console.warn("[raid-schedule] cancel ping failed:", error?.message || error);
      }
    }
  }

  // Lead kick panel: a multi-select of the whole signup pool (comp +
  // waitlist + RSVP), so the lead can drop anyone. Removing a slot-holder
  // frees the slot, which detectPromotion turns into a waitlist promotion.
  function kickSelectPayload(event, lang) {
    const pool = (event.signups || []).slice(0, 25); // Discord select option cap
    const options = pool.map((s) => ({
      label: clip(s.characterName, 100),
      value: s.discordId,
      description: clip(`${s.accountName} · ${s.characterClass} · ${s.characterItemLevel}`, 100),
    }));
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rse:kickpick:${event._id}`)
      .setPlaceholder(t("raid-schedule.kick.placeholder", lang))
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options);
    return {
      embeds: [
        noticeEmbed(
          "warn",
          t("raid-schedule.kick.title", lang),
          t("raid-schedule.kick.intro", lang),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
      flags: ephemeralFlag,
    };
  }

  async function handleKick(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    if (!Array.isArray(event.signups) || event.signups.length === 0) {
      await replyNotice(interaction, lang, "warn", "kickEmptyTitle", "kickEmptyDescription");
      return;
    }
    await interaction.reply(kickSelectPayload(event, lang));
  }

  async function handleKickSelect(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await editNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await editNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    const before = Array.from(event.signups || []);
    const { signups: next, removed } = applyKick(before, interaction.values || []);
    if (removed.length === 0) {
      // Everything selected was already gone (they self-left first).
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

    // Kicking a slot-holder may pull a waitlister in - ping them publicly so
    // they actually get notified (mentions only fire from message content,
    // not embeds · see feedback_discord_embed_mentions).
    const promoted = detectPromotion(before, next, {
      supSlots: event.supSlots,
      dpsSlots: event.dpsSlots,
    });
    if (promoted.length > 0) {
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

  function markTurns(event, turns) {
    event.turns = turns;
    if (typeof event.markModified === "function") event.markModified("turns");
  }

  // Lead control panel for the multi-turn (bus) plan. Lists turns + a
  // select to pick which turn to edit (or add one). Picking a turn swaps
  // in a multi-select of the signup pool with current members pre-checked.
  function teamsPanelPayload(event, lang) {
    const turns = Array.isArray(event.turns) ? event.turns : [];
    const lines = turns.length
      ? turns
          .map((tn) => t("raid-schedule.teams.turnLine", lang, { name: tn.name, n: (tn.memberIds || []).length }))
          .join("\n")
      : t("raid-schedule.teams.none", lang);
    const options = turns.map((tn, i) => ({
      label: clip(tn.name, 100),
      value: String(i),
      description: clip(t("raid-schedule.teams.memberCount", lang, { n: (tn.memberIds || []).length }), 100),
    }));
    options.push({ label: t("raid-schedule.teams.newTurn", lang), value: "new" });
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rse:teamturn:${event._id}`)
        .setPlaceholder(t("raid-schedule.teams.pickTurn", lang))
        .addOptions(options.slice(0, 25)),
    );
    return {
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.teams.title", lang),
          `${t("raid-schedule.teams.intro", lang)}\n\n${lines}`,
        ),
      ],
      components: [row],
      flags: ephemeralFlag,
    };
  }

  function memberSelectPayload(event, turnIndex, lang) {
    const turn = event.turns[turnIndex];
    const current = new Set(turn.memberIds || []);
    const pool = (event.signups || []).slice(0, 25); // Discord select option cap
    const options = pool.map((s) => ({
      label: clip(s.characterName, 100),
      value: s.discordId,
      description: clip(`${s.characterClass} · ${s.characterItemLevel}`, 100),
      default: current.has(s.discordId),
    }));
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rse:teammembers:${turnIndex}:${event._id}`)
      .setPlaceholder(clip(t("raid-schedule.teams.pickMembers", lang, { turn: turn.name }), 150))
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options);
    return {
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.teams.assignTitle", lang, { turn: turn.name }),
          t("raid-schedule.teams.assignIntro", lang),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
    };
  }

  async function handleTeams(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    await interaction.reply(teamsPanelPayload(event, lang));
  }

  async function handleTeamTurnSelect(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await editNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await editNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    if (!Array.isArray(event.signups) || event.signups.length === 0) {
      await editNotice(interaction, lang, "warn", "teamsNoPoolTitle", "teamsNoPoolDescription");
      return;
    }
    const value = interaction.values?.[0];
    let turnIndex;
    if (value === "new") {
      const turns = addTurn(
        event.turns,
        t("raid-schedule.teams.turnNameDefault", lang, { n: (event.turns?.length || 0) + 1 }),
      );
      markTurns(event, turns);
      await event.save();
      turnIndex = turns.length - 1;
    } else {
      turnIndex = Number(value);
      if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= (event.turns?.length || 0)) {
        await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
        return;
      }
    }
    const payload = memberSelectPayload(event, turnIndex, lang);
    await interaction.editReply({ embeds: payload.embeds, components: payload.components });
  }

  async function handleTeamMembersSelect(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await editNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await editNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    const parsed = parseCustomId(interaction.customId);
    const turnIndex = Number(parsed.action.split(":")[1]);
    if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= (event.turns?.length || 0)) {
      await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
      return;
    }
    const turns = setTurnMembers(event.turns, turnIndex, interaction.values || []);
    markTurns(event, turns);
    await event.save();
    const payload = teamsPanelPayload(event, lang);
    await interaction.editReply({ embeds: payload.embeds, components: payload.components });
  }

  // /raid-schedule-preview show -> post the public turn plan for the
  // channel's active event. Read-only, so anyone can run it (no lead gate).
  async function handleShowCommand(interaction) {
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId || interaction.channel?.id;
    const lang = await userLang(interaction);
    if (!guildId || !channelId) {
      await replyNotice(interaction, lang, "danger", "guildOnlyTitle", "guildOnlyDescription");
      return;
    }
    const event = await RaidEvent.findOne({
      guildId,
      channelId,
      status: { $in: ["open", "locked"] },
    }).sort({ createdAt: -1 });
    if (!event) {
      await replyNotice(interaction, lang, "warn", "showNoEventTitle", "showNoEventDescription");
      return;
    }
    const langForBoard = await boardLang(guildId);
    await interaction.reply({
      embeds: [buildTurnPlanEmbed(event, { EmbedBuilder, UI, lang: langForBoard })],
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
    if (parsed.action === "manage") return handleManage(interaction, event, lang);
    if (parsed.action === "teams") return handleTeams(interaction, event, lang);
    if (parsed.action === "kick") return handleKick(interaction, event, lang);
    if (parsed.action === "setroom") return handleSetRoom(interaction, event, lang);
    if (parsed.action === "edittime") return handleEditTime(interaction, event, lang);
    if (parsed.action === "cancel") return handleCancel(interaction, event, lang);
    await replyNotice(interaction, lang, "warn", "unknownTitle", "unknownDescription");
  }

  async function handleRaidScheduleSelect(interaction) {
    const parsed = parseCustomId(interaction.customId);
    await interaction.deferUpdate();
    const lang = await userLang(interaction);
    const event = parsed ? await loadEvent(parsed.eventId) : null;
    if (!event) {
      await editNotice(interaction, lang, "warn", "missingEventTitle", "missingEventDescription");
      return;
    }
    if (parsed.action === "pick") return handlePick(interaction, event, lang);
    if (parsed.action === "kickpick") return handleKickSelect(interaction, event, lang);
    if (parsed.action === "teamturn") return handleTeamTurnSelect(interaction, event, lang);
    if (parsed.action.startsWith("teammembers")) return handleTeamMembersSelect(interaction, event, lang);
    await editNotice(interaction, lang, "warn", "unknownTitle", "unknownDescription");
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
