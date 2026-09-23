const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require("discord.js");

const { createRaidScheduleCommand } = require("../bot/handlers/raid/schedule");
const { UI } = require("../bot/utils/raid/common/shared");

function makeCommand(event) {
  const User = { findOne: () => ({ lean: async () => ({ language: "en" }) }) };
  const GuildConfig = { findOne: () => ({ lean: async () => null }) };
  const RaidEvent = { async findById(id) { return String(id) === String(event._id) ? event : null; } };
  return createRaidScheduleCommand({
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
    UI, User, GuildConfig, RaidEvent,
    isManagerId: (id) => id === "lead",
    applyRaidSetBatchForDiscordId: async () => [],
  });
}

// RaidEvent uses optimistic concurrency: a save that lost a race throws this.
function makeRacedEvent() {
  return {
    _id: "ev1", guildId: "g1", channelId: "c1", messageId: "m1", creatorId: "lead",
    raidKey: "armoche", modeKey: "hard", minItemLevel: 1720, partySize: 8, supSlots: 2, dpsSlots: 6,
    title: "Tonight", startAt: new Date(Date.UTC(2026, 5, 5, 13, 0)), status: "open", turns: [],
    signups: [{ discordId: "u1", characterName: "Du", characterClass: "Sorceress", characterItemLevel: 1720, role: "dps", status: "confirmed", joinedAt: 1 }],
    async save() {
      throw Object.assign(new Error('No matching document found for id "ev1"'), { name: "VersionError" });
    },
  };
}

test("an RSVP that loses a concurrent save tells the member the board changed", async () => {
  const notices = [];
  const interaction = {
    customId: "rse:rsvp:tentative:ev1", user: { id: "u1" }, guildId: "g1", channelId: "c1",
    deferred: false, replied: false,
    async deferUpdate() { this.deferred = true; },
    async editReply() {},
    async followUp(payload) { notices.push(payload); },
    async reply(payload) { notices.push(payload); },
  };
  await makeCommand(makeRacedEvent()).handleRaidScheduleButton(interaction);

  assert.equal(notices.length, 1);
  assert.match(notices[0].embeds[0].toJSON().title, /board just changed/i);
});

test("a save that fails for another reason still reaches the router", async () => {
  const event = makeRacedEvent();
  event.save = async () => { throw new Error("connection reset"); };
  const interaction = {
    customId: "rse:rsvp:tentative:ev1", user: { id: "u1" }, guildId: "g1", channelId: "c1",
    deferred: false, replied: false,
    async deferUpdate() { this.deferred = true; },
    async editReply() {},
    async followUp() { assert.fail("Only a lost race gets the board-changed notice"); },
  };
  await assert.rejects(makeCommand(event).handleRaidScheduleButton(interaction), /connection reset/);
});

test("a turn picker that loses a concurrent save is replaced by the same notice", async () => {
  const edits = [];
  const interaction = {
    customId: "rse:teamturn:ev1", user: { id: "lead" }, guildId: "g1", channelId: "c1", values: ["new"],
    deferred: false, replied: false,
    async deferUpdate() { this.deferred = true; },
    async editReply(payload) { edits.push(payload); },
  };
  await makeCommand(makeRacedEvent()).handleRaidScheduleSelect(interaction);

  assert.match(edits.at(-1).embeds[0].toJSON().title, /board just changed/i);
});
