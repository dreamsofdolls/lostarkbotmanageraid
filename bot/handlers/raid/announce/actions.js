"use strict";

const { handleClearAnnouncementChannel, handleSetAnnouncementChannel } = require("./channel");
const { handleShowAnnouncement } = require("./show");
const { handleToggleAnnouncement } = require("./toggle");

const RAID_ANNOUNCE_ACTIONS = Object.freeze([
  "show",
  "on",
  "off",
  "set-channel",
  "clear-channel",
]);

const RAID_ANNOUNCE_ACTION_HANDLERS = Object.freeze({
  show: handleShowAnnouncement,
  on: handleToggleAnnouncement,
  off: handleToggleAnnouncement,
  "set-channel": handleSetAnnouncementChannel,
  "clear-channel": handleClearAnnouncementChannel,
});

function isValidRaidAnnounceAction(action) {
  return RAID_ANNOUNCE_ACTIONS.includes(action);
}

function getRaidAnnounceActionHandler(action) {
  return RAID_ANNOUNCE_ACTION_HANDLERS[action] || null;
}

module.exports = {
  RAID_ANNOUNCE_ACTIONS,
  getRaidAnnounceActionHandler,
  isValidRaidAnnounceAction,
};
