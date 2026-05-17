"use strict";

const { createInteractionRouter } = require("../services/discord/interaction-router");

const RAID_COMMAND_NAMES = Object.freeze([
  "raid-add-roster",
  "raid-edit-roster",
  "raid-check",
  "raid-set",
  "raid-status",
  "raid-help",
  "raid-remove-roster",
  "raid-channel",
  "raid-auto-manage",
  "raid-announce",
  "raid-task",
  "raid-gold-earner",
  "raid-share",
  "raid-language",
  "raid-bg",
]);

function createRaidInteractionRouter({ MessageFlags, handlers }) {
  return createInteractionRouter({
    MessageFlags,
    allowedCommands: RAID_COMMAND_NAMES,
    handleSlashCommand: handlers.handleRaidManagementCommand,
    autocompleteHandlers: {
      "raid-set": handlers.handleRaidSetAutocomplete,
      "raid-edit-roster": handlers.handleEditRosterAutocomplete,
      "raid-remove-roster": handlers.handleRemoveRosterAutocomplete,
      "raid-channel": handlers.handleRaidChannelAutocomplete,
      "raid-auto-manage": handlers.handleRaidAutoManageAutocomplete,
      "raid-announce": handlers.handleRaidAnnounceAutocomplete,
      "raid-task": handlers.handleRaidTaskAutocomplete,
      "raid-gold-earner": handlers.handleRaidGoldEarnerAutocomplete,
    },
    selectHandlers: {},
    selectRoutes: [
      { prefix: "raid-help:select:", handle: handlers.handleRaidHelpSelect },
      { prefix: "raid-language:select", handle: handlers.handleRaidLanguageSelect },
    ],
    buttonRoutes: [
      { prefix: "raid-check:", handle: handlers.handleRaidCheckButton },
      { prefix: "add-roster:", handle: handlers.handleAddRosterButton },
      { prefix: "edit-roster:", handle: handlers.handleEditRosterButton },
      { prefix: "raid-task:", handle: handlers.handleRaidTaskButton },
      { prefix: "gold-earner:", handle: handlers.handleRaidGoldEarnerButton },
      { prefix: "stuck-nudge:", handle: handlers.handleStuckNudgeButton },
    ],
  });
}

module.exports = {
  RAID_COMMAND_NAMES,
  createRaidInteractionRouter,
};
