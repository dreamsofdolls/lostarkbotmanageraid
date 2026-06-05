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
const { listEligibleCharacters, partitionSelectable } = require("../../../services/raid/schedule/eligibility");
const { applyJoin, applyRsvp, applyKick } = require("../../../services/raid/schedule/signup-state");
const { assignSlots, detectPromotion } = require("../../../services/raid/schedule/slots");
const { selectAutoClearTargets } = require("../../../services/raid/schedule/auto-clear");
const { shapeOwnedBoardOptions } = require("../../../services/raid/schedule/owned-boards");
const {
  addTurn,
  setTurnMembers,
  removeMembersFromTurns,
} = require("../../../services/raid/schedule/turns");
const {
  buildScheduleEmbed,
  buildScheduleComponents,
  buildTurnPlanEmbed,
  buildSwitcherRow,
  renderGauge,
  STATUS_CODE,
} = require("./board");
const { getClassEmoji } = require("../../../models/Class");

const EPHEMERAL_FLAG = 1 << 6;
const PICKER_LIMIT = 25;
const CLOSED_EVENT_STATUSES = new Set(["cleared", "cancelled"]);

function createRaidScheduleCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
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

  // HUD kicker per notice type - a small `// CODE` line above the title that
  // gives every schedule confirmation the same operational-console feel.
  const NOTICE_KICKER = { danger: "// ERROR", success: "// OK", warn: "// HEADS UP", info: "// INFO" };
  function noticeEmbed(type, title, description) {
    const color = type === "danger"
      ? UI.colors.danger
      : type === "success"
        ? UI.colors.success
        : type === "warn"
          ? UI.colors.progress
          : UI.colors.neutral;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: NOTICE_KICKER[type] || "// INFO" })
      .setTitle(title);
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

  // Async because the board carries a "Board khác của lead" switcher that must
  // survive every re-render (join/rsvp/kick all funnel through editBoardMessage
  // -> boardPayload). We re-derive the creator's active boards on each render -
  // one guild+channel-scoped creator query; board edits are click-driven so the
  // cost is negligible, and this keeps the switcher correct without stored state.
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
        // No silent caps: shapeOwnedBoardOptions trims to Discord's 25-option
        // limit, so flag when a busy lead has more boards than the switcher shows.
        if (owned.length > ownedBoardOptions.length) {
          console.warn(
            `[raid-schedule] board switcher capped: ${owned.length} owned boards, showing ${ownedBoardOptions.length}`,
          );
        }
      }
    } catch (error) {
      console.warn("[raid-schedule] owned-board query failed:", error?.message || error);
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

  function isClosedEvent(event) {
    return CLOSED_EVENT_STATUSES.has(event?.status);
  }

  async function rejectUnlessLead(
    interaction,
    lang,
    respond = replyNotice,
    titleKey = "managerOnlyTitle",
    descriptionKey = "managerOnlyDescription",
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
      await message.edit(await boardPayload(event, lang));
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
    // `show` resurfaces the lead's signup board (delete + repost = a lead
    // action), so it gates itself inside handleShowCommand. Routed early to
    // skip the create-only reject below.
    if (subcommand === "show") return handleShowCommand(interaction);

    const lang = await userLang(interaction);
    if (await rejectUnlessLead(interaction, lang, replyNotice, "notManagerTitle", "notManagerDescription")) return;
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
    const skipNotify = interaction.options.getBoolean("skip_notify") ?? false;
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
      skipNotify,
      status: "open",
      signups: [],
    });
    await event.save();

    const langForBoard = await boardLang(guildId);
    const message = await interaction.editReply(await boardPayload(event, langForBoard));
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

    // Already-cleared chars are dropped: re-signing a char that finished this
    // raid this week is pointless for a normal clear. allCleared lets us say
    // "all cleared" instead of the misleading "no char at iLvl".
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

  async function handleLockToggle(interaction, event, action, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    const onBoard = onBoardMessage(interaction, event);
    event.status = action === "unlock" ? "open" : "locked";
    await interaction.deferUpdate();
    await event.save();
    const langForBoard = await boardLang(event.guildId);
    if (onBoard) {
      await interaction.editReply(await boardPayload(event, langForBoard));
      return;
    }
    // From the Manage menu: update the canonical board, then re-render the
    // ephemeral menu so the Lock/Unlock label flips.
    await editBoardMessage(interaction, event, langForBoard);
    const menu = manageMenuPayload(event, lang);
    await interaction.editReply({ embeds: menu.embeds, components: menu.components });
  }

  async function handleEnd(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;

    await interaction.deferUpdate();
    const summary = await writeAutoClears(interaction, event);
    event.status = "cleared";
    event.clearedAt = new Date();
    await event.save();

    const langForBoard = await boardLang(event.guildId);
    const onBoard = onBoardMessage(interaction, event);
    // Gauge of clears written (updated/targets) in front of the warm summary.
    const endGauge = renderGauge(summary.updated, summary.targets);
    const summaryEmbed = noticeEmbed(
      summary.failed > 0 ? "warn" : "success",
      t("raid-schedule.notice.endedTitle", lang, summary),
      `${endGauge ? `${endGauge}  ` : ""}${t("raid-schedule.notice.endedDescription", lang, summary)}`,
    );
    if (onBoard) {
      await interaction.editReply(await boardPayload(event, langForBoard));
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
    const roomRaidLabel = raidMetaFor(event.raidKey, event.modeKey)?.label || `${event.raidKey} ${event.modeKey}`;
    await interaction.reply({
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.roomTitle", lang),
          `\`${roomRaidLabel}\`\n${t("raid-schedule.notice.roomDescription", lang, {
            room: event.roomName,
            passwordLine,
          })}`,
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
      new ButtonBuilder()
        .setCustomId(`rse:notify:${id}`)
        .setLabel(t(event.skipNotify ? "raid-schedule.btn.notifyOff" : "raid-schedule.btn.notifyOn", lang))
        .setStyle(ButtonStyle.Secondary),
    );
    const peopleRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:teams:${id}`)
        .setLabel(t("raid-schedule.btn.teams", lang))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`rse:addmember:${id}`)
        .setLabel(t("raid-schedule.btn.addMember", lang))
        .setStyle(ButtonStyle.Success),
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
      new ButtonBuilder()
        .setCustomId(`rse:delete:${id}`)
        .setLabel(t("raid-schedule.btn.deleteEvent", lang))
        .setStyle(ButtonStyle.Danger),
    );
    // HUD status readout so the lead sees the comp state at a glance in their
    // control panel: mono raid · status line + slot-fill gauge.
    const slots = assignSlots(event.signups, { supSlots: event.supSlots, dpsSlots: event.dpsSlots });
    const compCount = slots.support.length + slots.dps.length;
    const raidLabel = raidMetaFor(event.raidKey, event.modeKey)?.label || `${event.raidKey} ${event.modeKey}`;
    const gauge = renderGauge(compCount, event.partySize);
    const manageDesc = [
      `\`${raidLabel} · ${STATUS_CODE[event.status] || ""}\``,
      `${gauge ? `${gauge}  ` : ""}**${compCount}/${event.partySize}** · ⏳ ${slots.waitlist.length}`,
      t("raid-schedule.notice.manageDescription", lang),
    ].join("\n");
    return {
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.manageTitle", lang),
          manageDesc,
        ),
      ],
      components: [configRow, peopleRow, terminalRow],
      flags: ephemeralFlag,
    };
  }

  async function handleManage(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    await interaction.reply(manageMenuPayload(event, lang));
  }

  // Flip silent mode from the Manage menu, then re-render so the button label
  // updates (🔔 Báo BẬT <-> 🔕 Báo TẮT). Lead-only. Only the ping behaviour
  // changes - signups, board, auto-clear are untouched.
  async function handleToggleNotify(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    event.skipNotify = !event.skipNotify;
    await interaction.deferUpdate();
    await event.save();
    const menu = manageMenuPayload(event, lang);
    await interaction.editReply({ embeds: menu.embeds, components: menu.components });
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
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
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
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
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
    if (ids.length > 0 && !event.skipNotify) {
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

  // Best-effort removal of the board message. Unlike editBoardMessage (which
  // edits in place), this deletes the message entirely - used by manual delete.
  async function deleteBoardMessage(interaction, event) {
    if (!event.messageId || !event.channelId || !interaction.client?.channels) return false;
    try {
      const channel = await interaction.client.channels.fetch(event.channelId);
      const message = await channel?.messages?.fetch(event.messageId);
      if (message) {
        await message.delete();
        return true;
      }
    } catch (error) {
      console.warn("[raid-schedule] board delete failed:", error?.message || error);
    }
    return false;
  }

  // Manual hard-delete (lead). Cancel freezes the board as a record; Delete
  // removes the board message AND the RaidEvent doc. A confirm step guards the
  // irreversible loss (the auto-purge handles the routine weekly cleanup).
  function deleteConfirmPayload(event, lang) {
    const id = String(event._id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:delyes:${id}`)
        .setLabel(t("raid-schedule.btn.deleteConfirmYes", lang))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`rse:delno:${id}`)
        .setLabel(t("raid-schedule.btn.deleteConfirmNo", lang))
        .setStyle(ButtonStyle.Secondary),
    );
    return {
      embeds: [
        noticeEmbed(
          "danger",
          t("raid-schedule.notice.deleteConfirmTitle", lang),
          t("raid-schedule.notice.deleteConfirmDescription", lang),
        ),
      ],
      components: [row],
      flags: ephemeralFlag,
    };
  }

  async function handleDeletePrompt(interaction, event, lang) {
    if (await rejectUnlessLead(interaction, lang)) return;
    await interaction.reply(deleteConfirmPayload(event, lang));
  }

  async function handleDeleteConfirm(interaction, event, lang) {
    if (await rejectUnlessLead(interaction, lang, editNotice)) return;
    await interaction.deferUpdate();
    // Ping signups only if the event was still active - cleaning up an already
    // ended/cancelled event has no audience left to notify.
    const wasActive = event.status === "open" || event.status === "locked";
    const ids = [...new Set((event.signups || []).map((s) => s.discordId))];
    const langForBoard = await boardLang(event.guildId);

    try {
      await event.deleteOne();
    } catch (error) {
      console.warn("[raid-schedule] event delete failed:", error?.message || error);
      await interaction.editReply({
        embeds: [
          noticeEmbed(
            "danger",
            t("raid-schedule.notice.deleteFailedTitle", lang),
            t("raid-schedule.notice.deleteFailedDescription", lang),
          ),
        ],
        components: [],
      }).catch(() => {});
      return;
    }
    const boardDeleted = await deleteBoardMessage(interaction, event);

    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "warn",
          t("raid-schedule.notice.deletedTitle", lang),
          t(
            boardDeleted
              ? "raid-schedule.notice.deletedDescription"
              : "raid-schedule.notice.deletedBoardMissingDescription",
            lang,
          ),
        ),
      ],
      components: [],
    }).catch(() => {});

    if (wasActive && ids.length > 0 && !event.skipNotify) {
      try {
        const channel = await interaction.client.channels.fetch(event.channelId);
        await channel?.send?.({
          content: t("raid-schedule.notice.cancelPingContent", langForBoard, {
            users: ids.map((uid) => `<@${uid}>`).join(" "),
            title: event.title || "",
          }),
        });
      } catch (error) {
        console.warn("[raid-schedule] delete ping failed:", error?.message || error);
      }
    }
  }

  async function handleDeleteAbort(interaction, event, lang) {
    await interaction.deferUpdate().catch(() => {});
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.deleteAbortedTitle", lang),
          t("raid-schedule.notice.deleteAbortedDescription", lang),
        ),
      ],
      components: [],
    }).catch(() => {});
  }

  // Lead kick panel: a multi-select of the whole signup pool (comp +
  // waitlist + RSVP), so the lead can drop anyone. Removing a slot-holder
  // frees the slot, which detectPromotion turns into a waitlist promotion.
  function kickSelectPayload(event, lang) {
    const pool = (event.signups || []).slice(0, 25); // Discord select option cap
    // Same option shape as the Join / Add-member pickers: class as the icon
    // (not a name), description `account · ilvl · role`. The icon conveys class.
    const options = pool.map((s) => {
      const emoji = classEmojiOption(s.characterClass);
      const roleKey = s.role === "support" ? "support" : "dps";
      return {
        label: clip(s.characterName, 100),
        value: s.discordId,
        description: clip(`${s.accountName} · ${s.characterItemLevel} · ${t(`raid-schedule.picker.role.${roleKey}`, lang)}`, 100),
        ...(emoji ? { emoji } : {}),
      };
    });
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

  // Lead add-member: a native User Select picks the target, then a char Select
  // (the target's eligible roster) writes the signup on their behalf via
  // applyJoin. Works even when locked (manager-add bypasses the lock gate).
  function addUserSelectPayload(event, lang) {
    const select = new UserSelectMenuBuilder()
      .setCustomId(`rse:adduser:${event._id}`)
      .setPlaceholder(t("raid-schedule.addMember.userPlaceholder", lang))
      .setMinValues(1)
      .setMaxValues(1);
    return {
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.addMember.title", lang),
          t("raid-schedule.addMember.intro", lang),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
      flags: ephemeralFlag,
    };
  }

  function addCharSelectPayload(event, targetId, rows, lang) {
    const options = rows.slice(0, PICKER_LIMIT).map((row) => {
      const roleKey = row.role === "support" ? "support" : "dps";
      const cleared = row.alreadyCleared
        ? ` ${t("raid-schedule.picker.alreadyClearedSuffix", lang)}`
        : "";
      const emoji = classEmojiOption(row.className);
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
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rse:addpick:${targetId}:${event._id}`)
      .setPlaceholder(t("raid-schedule.addMember.charPlaceholder", lang))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options);
    return {
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.addMember.charTitle", lang),
          t("raid-schedule.addMember.charIntro", lang, { user: `<@${targetId}>` }),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
    };
  }

  async function handleAddMember(interaction, event, lang) {
    // No lock check on purpose: manager-add is allowed on a locked board.
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
    // Same cleared-char rule as self-service Join: a char that already cleared
    // this raid this week has nothing to gain, so it is not offered.
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
    const parsed = parseCustomId(interaction.customId);
    const targetId = parsed.action.split(":")[1];
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

    const before = Array.from(event.signups || []);
    const next = applyJoin(before, {
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

    // Public ping so the added user actually gets notified (mentions only fire
    // from message content, not embeds · see feedback_discord_embed_mentions).
    // Silent mode (skipNotify) suppresses it - the member is still added + the
    // board updated above, just no @mention. This ping is the last statement.
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
    // Class icon (not name) + `account · ilvl · role`, consistent with the
    // Join / Add-member / Kick pickers.
    const options = pool.map((s) => {
      const emoji = classEmojiOption(s.characterClass);
      const roleKey = s.role === "support" ? "support" : "dps";
      return {
        label: clip(s.characterName, 100),
        value: s.discordId,
        description: clip(`${s.accountName} · ${s.characterItemLevel} · ${t(`raid-schedule.picker.role.${roleKey}`, lang)}`, 100),
        default: current.has(s.discordId),
        ...(emoji ? { emoji } : {}),
      };
    });
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
    if (await rejectUnlessLeadMutable(interaction, event, lang)) return;
    await interaction.reply(teamsPanelPayload(event, lang));
  }

  async function handleTeamTurnSelect(interaction, event, lang) {
    if (await rejectUnlessLeadMutable(interaction, event, lang, editNotice)) return;
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
    if (await rejectUnlessLeadMutable(interaction, event, lang, editNotice)) return;
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

  // Resurface a board: post a fresh copy at the bottom of its channel, repoint
  // messageId to it, THEN delete the old message. The post -> repoint -> delete
  // ORDER is the anti-ghost invariant: a failed post leaves the old board (and
  // its messageId) untouched, so we never strand a board the buttons edit
  // invisibly. `lang` is the guild board language.
  async function republishBoard(interaction, event, lang) {
    if (!event.channelId || !interaction.client?.channels) return { ok: false };
    let channel;
    try {
      channel = await interaction.client.channels.fetch(event.channelId);
    } catch (error) {
      console.warn("[raid-schedule] resurface channel fetch failed:", error?.message || error);
      return { ok: false };
    }
    if (!channel?.send) return { ok: false };

    let message;
    try {
      message = await channel.send(await boardPayload(event, lang));
    } catch (error) {
      console.warn("[raid-schedule] resurface post failed:", error?.message || error);
      return { ok: false }; // keep the old messageId - nothing moved
    }

    const oldMessageId = event.messageId;
    event.messageId = message.id;
    try {
      await event.save();
    } catch (error) {
      console.warn("[raid-schedule] resurface save failed:", error?.message || error);
      event.messageId = oldMessageId;
      try {
        if (typeof message.delete === "function") {
          await message.delete();
        } else if (message.id && channel.messages?.fetch) {
          const fresh = await channel.messages.fetch(message.id);
          if (fresh?.delete) await fresh.delete();
        }
      } catch (cleanupError) {
        console.warn("[raid-schedule] resurface new-delete failed:", cleanupError?.message || cleanupError);
      }
      return { ok: false };
    }
    // Best-effort: drop the stale board so only one copy survives. Sending
    // implies we can also delete our own message, so this rarely fails.
    if (oldMessageId && oldMessageId !== message.id) {
      try {
        const old = await channel.messages.fetch(oldMessageId);
        if (old) await old.delete();
      } catch (error) {
        console.warn("[raid-schedule] resurface old-delete failed:", error?.message || error);
      }
    }
    return { ok: true, message };
  }

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

  // Ephemeral confirmation after a resurface, with a jump link to the new board.
  function resurfacedNoticeEmbed(event, lang, message) {
    const raidLabel = raidMetaFor(event.raidKey, event.modeKey)?.label || `${event.raidKey} ${event.modeKey}`;
    return noticeEmbed(
      "success",
      t("raid-schedule.notice.resurfacedTitle", lang),
      t("raid-schedule.notice.resurfacedDescription", lang, {
        raid: raidLabel,
        channel: `<#${event.channelId}>`,
        link: message.url,
      }),
    );
  }

  // /raid-schedule-preview show -> branch on the `action` option. Default
  // (omitted) = resurface, so plain `show` bumps the board exactly as before.
  // turnplan = ephemeral turn-plan dashboard. Both manager-gated, both scoped
  // to the lead's OWN boards.
  async function handleShowCommand(interaction) {
    const action = interaction.options.getString("action") || "resurface";
    if (action === "turnplan") return handleShowTurnPlan(interaction);
    return handleShowResurface(interaction);
  }

  // action: 📋 Đẩy board lên -> resurface the lead's signup board to the bottom
  // of its channel (delete + repost + repoint messageId). Targets the board in
  // the current channel if the lead has one here, else their most recent active
  // board; the board's switcher reaches the rest.
  async function handleShowResurface(interaction) {
    const lang = await userLang(interaction);
    if (await rejectUnlessLead(interaction, lang, replyNotice, "notManagerTitle", "notManagerDescription")) return;
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId || interaction.channel?.id;
    if (!guildId || !channelId) {
      await replyNotice(interaction, lang, "danger", "guildOnlyTitle", "guildOnlyDescription");
      return;
    }

    const mine = await RaidEvent.find({
      guildId,
      creatorId: interaction.user.id,
      status: { $in: ["open", "locked"] },
    }).sort({ createdAt: -1 });
    if (mine.length === 0) {
      await replyNotice(interaction, lang, "warn", "showNoBoardsTitle", "showNoBoardsDescription");
      return;
    }
    // Prefer the board in the channel the lead is standing in; else most recent.
    const target = mine.find((e) => String(e.channelId) === String(channelId)) || mine[0];

    await interaction.deferReply({ flags: ephemeralFlag });
    const langForBoard = await boardLang(target.guildId);
    const res = await republishBoard(interaction, target, langForBoard);
    if (!res.ok) {
      await editNotice(interaction, lang, "danger", "resurfaceFailedTitle", "resurfaceFailedDescription");
      return;
    }
    await interaction.editReply({ embeds: [resurfacedNoticeEmbed(target, lang, res.message)], components: [] });
  }

  // action: 📊 Xem phân turn -> ephemeral turn-plan dashboard. Lists the lead's
  // own active boards GUILD-WIDE (cross-channel) and shows one board's turn
  // plan; the dropdown switches between their raids (the "overview" Traine
  // asked for). Read-only + ephemeral, so it never disturbs the public board.
  async function handleShowTurnPlan(interaction) {
    const lang = await userLang(interaction);
    if (await rejectUnlessLead(interaction, lang, replyNotice, "notManagerTitle", "notManagerDescription")) return;
    const guildId = interaction.guildId || interaction.guild?.id;
    if (!guildId) {
      await replyNotice(interaction, lang, "danger", "guildOnlyTitle", "guildOnlyDescription");
      return;
    }
    const channelId = interaction.channelId || interaction.channel?.id;
    const mine = await RaidEvent.find({
      guildId,
      creatorId: interaction.user.id,
      status: { $in: ["open", "locked"] },
    }).sort({ startAt: 1 });
    if (mine.length === 0) {
      await replyNotice(interaction, lang, "warn", "showNoBoardsTitle", "showNoBoardsDescription");
      return;
    }
    // Default selection = the board in the channel the lead stands in, else soonest.
    const target = mine.find((e) => String(e.channelId) === String(channelId)) || mine[0];
    await interaction.reply(turnPlanDashboardPayload(target, mine, lang));
  }

  // The ephemeral dashboard payload: the selected board's turn plan + a board
  // switcher (only when the lead runs >= 2 boards). Reused verbatim on switch.
  function turnPlanDashboardPayload(event, ownedEvents, lang) {
    const components = [];
    if (ownedEvents.length >= 2) {
      const rows = shapeOwnedBoardOptions(ownedEvents, String(event._id));
      components.push(buildSwitcherRow(String(event._id), rows, {
        ActionRowBuilder,
        StringSelectMenuBuilder,
        lang,
        action: "showtp",
        placeholderKey: "raid-schedule.show.tpSwitchPlaceholder",
      }));
    }
    return {
      embeds: [buildTurnPlanEmbed(event, { EmbedBuilder, UI, lang })],
      components,
      flags: ephemeralFlag,
    };
  }

  // 🗓 dashboard switcher -> swap the ephemeral to the chosen board's turn plan.
  // Read-only + ephemeral, so no message/messageId juggling like showpick. The
  // dashboard only ever lists the lead's own boards, re-guarded here race-safe.
  async function handleShowTpSelect(interaction, event, lang) {
    const chosen = await loadEvent(interaction.values?.[0]);
    if (!chosen || (chosen.status !== "open" && chosen.status !== "locked")) {
      await editNotice(interaction, lang, "warn", "missingEventTitle", "missingEventDescription");
      return;
    }
    if (
      String(chosen.creatorId) !== String(interaction.user.id) ||
      String(chosen.guildId) !== String(event.guildId)
    ) {
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

  // 🗓 Board khác switcher -> switch this visible board message in place.
  // `/show` is the bump action; the dropdown is a view switcher, so it edits the
  // message the user clicked, repoints the chosen event to that message, clears
  // the previous event's messageId, then best-effort deletes the chosen board's
  // old message to avoid two visible copies.
  async function handleShowPickSelect(interaction, event, lang) {
    if (String(event.creatorId) !== String(interaction.user.id)) {
      await interaction.followUp(noticePayload(lang, "warn", "showpickDeniedTitle", "showpickDeniedDescription"));
      return;
    }
    const chosen = await loadEvent(interaction.values?.[0]);
    if (!chosen || (chosen.status !== "open" && chosen.status !== "locked")) {
      await interaction.followUp(noticePayload(lang, "warn", "missingEventTitle", "missingEventDescription"));
      return;
    }
    if (String(chosen.guildId) !== String(event.guildId)) {
      await interaction.followUp(noticePayload(lang, "warn", "missingEventTitle", "missingEventDescription"));
      return;
    }
    if (String(chosen.channelId) !== String(event.channelId)) {
      await interaction.followUp(noticePayload(lang, "warn", "missingEventTitle", "missingEventDescription"));
      return;
    }
    // Re-check ownership on the chosen doc (race-safe: the switcher list could
    // be stale if a board changed hands - it can't today, but cheap to guard).
    if (String(chosen.creatorId) !== String(interaction.user.id)) {
      await interaction.followUp(noticePayload(lang, "warn", "showpickDeniedTitle", "showpickDeniedDescription"));
      return;
    }
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

    const previousEventMessageId = event.messageId;
    const previousChosenMessageId = chosen.messageId;
    event.messageId = null;
    try {
      await event.save();
    } catch (error) {
      console.warn("[raid-schedule] switch current save failed:", error?.message || error);
      await interaction.followUp(noticePayload(lang, "danger", "resurfaceFailedTitle", "resurfaceFailedDescription"));
      return;
    }

    chosen.messageId = currentMessageId;
    try {
      await chosen.save();
    } catch (error) {
      console.warn("[raid-schedule] switch chosen save failed:", error?.message || error);
      event.messageId = previousEventMessageId;
      await event.save().catch((rollbackError) => {
        console.warn("[raid-schedule] switch rollback current failed:", rollbackError?.message || rollbackError);
      });
      await interaction.followUp(noticePayload(lang, "danger", "resurfaceFailedTitle", "resurfaceFailedDescription"));
      return;
    }

    try {
      await interaction.editReply(await boardPayload(chosen, langForBoard));
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
      return;
    }

    if (previousChosenMessageId && String(previousChosenMessageId) !== String(currentMessageId)) {
      await deleteMessageById(interaction, chosen.channelId, previousChosenMessageId);
    }
  }

  const BUTTON_ACTION_HANDLERS = Object.freeze({
    join: handleJoin,
    end: handleEnd,
    room: handleRoom,
    help: (interaction, event, lang) => handleHelp(interaction, lang),
    manage: handleManage,
    teams: handleTeams,
    addmember: handleAddMember,
    kick: handleKick,
    setroom: handleSetRoom,
    edittime: handleEditTime,
    notify: handleToggleNotify,
    cancel: handleCancel,
    delete: handleDeletePrompt,
    delyes: handleDeleteConfirm,
    delno: handleDeleteAbort,
  });

  function resolveButtonActionHandler(action) {
    if (!action) return null;
    if (action.startsWith("rsvp:")) {
      return (interaction, event, lang) =>
        handleRsvp(interaction, event, action.slice("rsvp:".length), lang);
    }
    if (action === "lock" || action === "unlock") {
      return (interaction, event, lang) => handleLockToggle(interaction, event, action, lang);
    }
    return BUTTON_ACTION_HANDLERS[action] || null;
  }

  const SELECT_ACTION_HANDLERS = Object.freeze({
    pick: handlePick,
    kickpick: handleKickSelect,
    adduser: handleAddUserSelect,
    teamturn: handleTeamTurnSelect,
    showpick: handleShowPickSelect,
    showtp: handleShowTpSelect,
  });

  function resolveSelectActionHandler(action) {
    if (!action) return null;
    if (action.startsWith("addpick")) return handleAddPickSelect;
    if (action.startsWith("teammembers")) return handleTeamMembersSelect;
    return SELECT_ACTION_HANDLERS[action] || null;
  }

  async function handleRaidScheduleButton(interaction) {
    const lang = await userLang(interaction);
    const parsed = parseCustomId(interaction.customId);
    const event = parsed ? await loadEvent(parsed.eventId) : null;
    if (!event) {
      await replyNotice(interaction, lang, "warn", "missingEventTitle", "missingEventDescription");
      return;
    }

    const handler = resolveButtonActionHandler(parsed.action);
    if (handler) return handler(interaction, event, lang);
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
    const handler = resolveSelectActionHandler(parsed.action);
    if (handler) return handler(interaction, event, lang);
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
