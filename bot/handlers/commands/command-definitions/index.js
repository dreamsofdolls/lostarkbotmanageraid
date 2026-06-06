"use strict";

const {
  createAddRosterCommandDefinition,
  createEditRosterCommandDefinition,
  createRaidGoldEarnerCommandDefinition,
  createRemoveRosterCommandDefinition,
} = require("./roster");
const {
  createRaidCheckCommandDefinition,
  createRaidSetCommandDefinition,
  createStatusCommandDefinition,
  createRaidProfileCommandDefinition,
} = require("./progress");
const {
  createRaidHelpCommandDefinition,
  createRaidLanguageCommandDefinition,
  createRaidShareCommandDefinition,
  createRaidAuctionCommandDefinition,
} = require("./social");
const {
  createRaidChannelCommandDefinition,
  createRaidAutoManageCommandDefinition,
  createRaidAnnounceCommandDefinition,
} = require("./admin");
const { createRaidTaskCommandDefinition } = require("./task");
const { createRaidBgCommandDefinition } = require("./background");
const { createRaidScheduleCommandDefinition } = require("./schedule");

function createRaidCommandDefinitions({
  announcementTypeKeys,
  announcementTypeEntry,
}) {
  return [
    createAddRosterCommandDefinition(),
    createEditRosterCommandDefinition(),
    createRaidCheckCommandDefinition(),
    createRaidSetCommandDefinition(),
    createStatusCommandDefinition(),
    createRaidProfileCommandDefinition(),
    createRaidHelpCommandDefinition(),
    createRaidGoldEarnerCommandDefinition(),
    createRemoveRosterCommandDefinition(),
    createRaidChannelCommandDefinition(),
    createRaidAutoManageCommandDefinition(),
    createRaidAnnounceCommandDefinition({
      announcementTypeKeys,
      announcementTypeEntry,
    }),
    createRaidTaskCommandDefinition(),
    createRaidShareCommandDefinition(),
    createRaidLanguageCommandDefinition(),
    createRaidBgCommandDefinition(),
    createRaidAuctionCommandDefinition(),
    createRaidScheduleCommandDefinition(),
  ];
}

module.exports = {
  createRaidCommandDefinitions,
};
