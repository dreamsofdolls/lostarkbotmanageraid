/**
 * app/interaction-router-registry.js
 * Allowlist of slash command names this bot owns + route map for
 * non-slash interactions (autocomplete, select, button). CRITICAL: any
 * new slash command must be added to RAID_COMMAND_NAMES below or the
 * router rejects it with "unknown command" - the dispatch map in
 * commands.js alone is not enough. A parity test in
 * test/router-registry.test.js asserts every registered slash command
 * appears here.
 */

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
  "raid-auction",
  "raid-schedule-preview",
]);

/**
 * Build the interaction router for the bot's command surface. Wires
 * the slash dispatcher + per-command autocomplete handlers +
 * prefix-routed select/button handlers into a single Interaction
 * dispatcher consumed by lifecycle.js.
 * @param {{MessageFlags: object, handlers: object}} deps - handlers must expose every method named below
 * @returns {Function} interaction dispatcher · async (interaction) => void
 */
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
      { prefix: "rse:", handle: handlers.handleRaidScheduleSelect },
    ],
    buttonRoutes: [
      { prefix: "rse:", handle: handlers.handleRaidScheduleButton },
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
