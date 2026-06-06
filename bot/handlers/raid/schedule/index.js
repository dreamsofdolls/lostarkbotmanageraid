/**
 * handlers/raid/schedule/index.js
 * Live interaction layer for /raid-schedule. The pure schedule services own
 * slot math, RSVP mutation, and auto-clear target selection; this file only
 * bridges them to Discord interactions and persisted RaidEvent documents.
 */

"use strict";

const { t } = require("../../../services/i18n");
const {
  RAID_REQUIREMENTS,
} = require("../../../domain/raid-catalog");
const {
  addTurn,
  setTurnMembers,
} = require("../../../services/raid/schedule/turns");
const {
  buildScheduleEmbed,
  buildScheduleComponents,
} = require("./view/board");
const {
  clip,
} = require("./view/select-options");
const { createScheduleNoticeHelpers } = require("./view/notices");
const { createSchedulePanelBuilders } = require("./view/panels");
const {
  parseScheduleCustomId,
  resolveScheduleActionHandler,
} = require("./router");
const { createScheduleRuntimeHelpers } = require("./runtime");
const { createScheduleCoreActions } = require("./actions/core-actions");
const { createScheduleCancelActions } = require("./actions/cancel-actions");
const { createScheduleDeleteActions } = require("./actions/delete-actions");
const { createScheduleModalActions } = require("./actions/modal-actions");
const { createScheduleShowActions } = require("./show/show-actions");
const { createScheduleParticipantActions } = require("./actions/participant-actions");
const { createScheduleMemberActions } = require("./actions/member-actions");

const EPHEMERAL_FLAG = 1 << 6;
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
  const {
    noticeEmbed,
    noticePayload,
    replyNotice,
    editNotice,
  } = createScheduleNoticeHelpers({ EmbedBuilder, UI, ephemeralFlag });
  const {
    manageMenuPayload,
    deleteConfirmPayload,
    kickSelectPayload,
    addUserSelectPayload,
    addCharSelectPayload,
    teamsPanelPayload,
    memberSelectPayload,
    turnPlanDashboardPayload,
  } = createSchedulePanelBuilders({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    UserSelectMenuBuilder,
    EmbedBuilder,
    UI,
    ephemeralFlag,
    noticeEmbed,
  });

  const {
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
    rejectUnlessLead,
    rejectUnlessLeadMutable,
    userLang,
    writeAutoClears,
  } = createScheduleRuntimeHelpers({
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
  });
  async function handleRaidScheduleCommand(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const handler = SCHEDULE_COMMAND_HANDLERS[subcommand];
    if (handler) return handler(interaction);

    const lang = await userLang(interaction);
    await replyNotice(interaction, lang, "warn", "unknownTitle", "unknownDescription");
  }

  const {
    handleCreateCommand,
    handleEnd,
    handleHelp,
    handleLockToggle,
    handleManage,
    handleRoom,
    handleToggleNotify,
  } = createScheduleCoreActions({
    RaidEvent,
    ephemeralFlag,
    userLang,
    boardLang,
    boardPayload,
    editBoardMessage,
    isCompMember,
    onBoardMessage,
    raidMetaFor,
    rejectUnlessLead,
    rejectUnlessLeadMutable,
    writeAutoClears,
    manageMenuPayload,
    noticeEmbed,
    replyNotice,
  });
  const {
    handleDeleteAbort,
    handleDeleteConfirm,
    handleDeletePrompt,
  } = createScheduleDeleteActions({
    boardLang,
    rejectUnlessLead,
    editNotice,
    deleteConfirmPayload,
    noticeEmbed,
  });

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
    const parsed = parseScheduleCustomId(interaction.customId);
    const turnIndex = Number(parsed?.action.split(":")[1]);
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

  const { handleCancel } = createScheduleCancelActions({
    boardLang,
    editBoardMessage,
    rejectUnlessLeadMutable,
    noticeEmbed,
    ephemeralFlag,
  });

  const {
    handleEditTime,
    handleSetRoom,
  } = createScheduleModalActions({
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
  });

  const {
    handleShowCommand,
    handleShowPickSelect,
    handleShowTpSelect,
  } = createScheduleShowActions({
    RaidEvent,
    ephemeralFlag,
    userLang,
    boardLang,
    boardPayload,
    loadEvent,
    raidMetaFor,
    rejectUnlessLead,
    replyNotice,
    editNotice,
    noticePayload,
    noticeEmbed,
    turnPlanDashboardPayload,
  });

  const {
    handleJoin,
    handlePick,
    handleRsvp,
  } = createScheduleParticipantActions({
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
  });

  const {
    handleKick,
    handleKickSelect,
    handleAddMember,
    handleAddUserSelect,
    handleAddPickSelect,
  } = createScheduleMemberActions({
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
  });

  const SCHEDULE_COMMAND_HANDLERS = Object.freeze({
    create: handleCreateCommand,
    show: handleShowCommand,
  });

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
    lock: (interaction, event, lang) => handleLockToggle(interaction, event, "lock", lang),
    unlock: (interaction, event, lang) => handleLockToggle(interaction, event, "unlock", lang),
  });

  const BUTTON_PREFIX_HANDLERS = Object.freeze([
    {
      prefix: "rsvp:",
      create: (action) => (interaction, event, lang) =>
        handleRsvp(interaction, event, action.slice("rsvp:".length), lang),
    },
  ]);

  const SELECT_ACTION_HANDLERS = Object.freeze({
    pick: handlePick,
    kickpick: handleKickSelect,
    adduser: handleAddUserSelect,
    teamturn: handleTeamTurnSelect,
    showpick: handleShowPickSelect,
    showtp: handleShowTpSelect,
  });

  const SELECT_PREFIX_HANDLERS = Object.freeze([
    { prefix: "addpick", create: () => handleAddPickSelect },
    { prefix: "teammembers", create: () => handleTeamMembersSelect },
  ]);

  async function loadScheduleComponentContext(interaction, { beforeLoad = null } = {}) {
    const parsed = parseScheduleCustomId(interaction.customId);
    if (typeof beforeLoad === "function") await beforeLoad();
    const lang = await userLang(interaction);
    const event = parsed ? await loadEvent(parsed.eventId) : null;
    return { parsed, lang, event };
  }

  async function handleRaidScheduleButton(interaction) {
    const { parsed, lang, event } = await loadScheduleComponentContext(interaction);
    if (!event) {
      await replyNotice(interaction, lang, "warn", "missingEventTitle", "missingEventDescription");
      return;
    }

    const handler = resolveScheduleActionHandler(
      parsed.action,
      BUTTON_ACTION_HANDLERS,
      BUTTON_PREFIX_HANDLERS,
    );
    if (handler) return handler(interaction, event, lang);
    await replyNotice(interaction, lang, "warn", "unknownTitle", "unknownDescription");
  }

  async function handleRaidScheduleSelect(interaction) {
    const { parsed, lang, event } = await loadScheduleComponentContext(interaction, {
      beforeLoad: () => interaction.deferUpdate(),
    });
    if (!event) {
      await editNotice(interaction, lang, "warn", "missingEventTitle", "missingEventDescription");
      return;
    }
    const handler = resolveScheduleActionHandler(
      parsed.action,
      SELECT_ACTION_HANDLERS,
      SELECT_PREFIX_HANDLERS,
    );
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
