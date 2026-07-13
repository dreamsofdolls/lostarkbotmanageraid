const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require("discord.js");

const { createRaidScheduleCommand } = require("../bot/handlers/raid/schedule");
const { UI } = require("../bot/utils/raid/common/shared");

function queryResult(arr) {
  return { sort() { return this; }, lean() { return Promise.resolve(arr); }, then(r, j) { return Promise.resolve(arr).then(r, j); } };
}
function makeCommand(event) {
  const User = { findOne: () => ({ lean: async () => ({ language: "en" }) }) };
  const GuildConfig = { findOne: () => ({ lean: async () => null }) };
  const RaidEvent = { find: () => queryResult([event]), async findById(id) { return String(id) === String(event._id) ? event : null; } };
  return createRaidScheduleCommand({
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
    UI, User, GuildConfig, RaidEvent,
    isManagerId: (id) => id === "lead",
    applyRaidSetBatchForDiscordId: async () => [],
  });
}
function makeEvent(extra = {}) {
  return {
    _id: "ev1", guildId: "g1", channelId: "c1", messageId: "m1", creatorId: "lead",
    raidKey: "armoche", modeKey: "hard", minItemLevel: 1720, partySize: 8, supSlots: 2, dpsSlots: 6,
    title: "Tonight", startAt: new Date(Date.UTC(2026, 5, 5, 13, 0)), status: "open",
    signups: [{ discordId: "u1", characterName: "Du", characterClass: "Sorceress", characterItemLevel: 1720, role: "dps", status: "confirmed", joinedAt: 1 }],
    skipNotify: false, async save() {}, ...extra,
  };
}
// Channel stub that records send() calls for public-ping suppression checks.
function makeChannel(order) {
  return {
    async send() { order.push("ping"); },
    messages: { async fetch() { return { async edit() {}, async delete() {} }; } },
  };
}
function cancelInteraction(order) {
  return {
    customId: "rse:cancel:ev1", user: { id: "lead" }, guildId: "g1", channelId: "c1",
    client: { channels: { async fetch() { return makeChannel(order); } } },
    async deferUpdate() {}, async editReply() {},
  };
}

test("cancel pings signups when notify is ON", async () => {
  const order = [];
  await makeCommand(makeEvent({ skipNotify: false })).handleRaidScheduleButton(cancelInteraction(order));
  assert.ok(order.includes("ping"), "a cancel ping was sent");
});

test("cancel is SILENT when skipNotify is on (event still cancelled)", async () => {
  const order = [];
  const event = makeEvent({ skipNotify: true });
  await makeCommand(event).handleRaidScheduleButton(cancelInteraction(order));
  assert.equal(order.includes("ping"), false, "no ping when silent mode is on");
  assert.equal(event.status, "cancelled", "the event is still cancelled - only the ping is suppressed");
});

test("the Manage notify button flips skipNotify", async () => {
  const event = makeEvent({ skipNotify: false });
  let saved = false;
  event.save = async () => { saved = true; };
  const interaction = {
    customId: "rse:notify:ev1", user: { id: "lead" }, guildId: "g1", channelId: "c1",
    async deferUpdate() {}, async editReply() {},
  };
  await makeCommand(event).handleRaidScheduleButton(interaction);
  assert.equal(event.skipNotify, true, "notify toggled off (skipNotify on)");
  assert.ok(saved, "persisted");

  await makeCommand(event).handleRaidScheduleButton({ ...interaction });
  assert.equal(event.skipNotify, false, "toggled back on");
});
