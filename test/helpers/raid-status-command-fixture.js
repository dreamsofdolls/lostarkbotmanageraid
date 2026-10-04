"use strict";

const discord = require("discord.js");
const User = require("../../bot/models/user");
const RosterShare = require("../../bot/models/RosterShare");
const RaidEvent = require("../../bot/models/RaidEvent");
const UserBackground = require("../../bot/models/userBackground");
const common = require("../../bot/utils/raid/common/shared");
const character = require("../../bot/utils/raid/common/character");

// Stubs every read /raid-status makes besides the viewer's own User document.
function mockStatusSideReads(t) {
  t.mock.method(User, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(RosterShare, "find", () => ({ lean: async () => [] }));
  t.mock.method(RaidEvent, "find", () => ({ sort() { return this; }, lean: async () => [] }));
  t.mock.method(UserBackground, "findOne", () => ({ select() { return this; }, lean: async () => null }));
}

// A reply message whose component collector records its handlers by event.
function createCollectorMessage(listeners) {
  return {
    createMessageComponentCollector: () => ({
      on(event, handler) { listeners.set(event, handler); return this; },
    }),
  };
}

function buildPaginationRow(_page, _pages, disabled) {
  return new discord.ActionRowBuilder().addComponents(
    new discord.ButtonBuilder().setCustomId("status:prev").setLabel("Previous").setStyle(discord.ButtonStyle.Secondary).setDisabled(disabled),
    new discord.ButtonBuilder().setCustomId("status:next").setLabel("Next").setStyle(discord.ButtonStyle.Secondary).setDisabled(disabled),
  );
}

// Offline createRaidStatusCommand dependencies; tests add their roster and Bible stubs.
function createStatusCommandDeps(overrides) {
  return {
    ...discord, ...common, ...character, User,
    saveWithRetry: async fn => fn(), ensureFreshWeek: () => false,
    getAutoManageCooldownMs: () => 0, getRosterRefreshCooldownMs: () => 0,
    formatRosterRefreshCooldownRemaining: () => "",
    buildPaginationRow,
    ...overrides,
  };
}

module.exports = { createCollectorMessage, createStatusCommandDeps, mockStatusSideReads };
