const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require("discord.js");

const { createRaidScheduleCommand } = require("../bot/handlers/raid/schedule");
const { applyCharacterJoin } = require("../bot/services/raid/schedule/slots/signup-state");
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

// 30 signups (past the 25-option picker cap). u3 is in Turn 1 and then
// re-joins with another character, which moves them to the end (index 29).
function makeCrowdedEvent() {
  let signups = [];
  for (let i = 1; i <= 30; i += 1) {
    signups = applyCharacterJoin(signups, `u${i}`, { accountName: `A${i}`, name: `C${i}`, className: "Berserker", itemLevel: 1720 });
  }
  signups = applyCharacterJoin(signups, "u3", { accountName: "A3", name: "C3b", className: "Bard", itemLevel: 1725 });
  return {
    _id: "ev1", guildId: "g1", channelId: "c1", messageId: "m1", creatorId: "lead",
    raidKey: "armoche", modeKey: "hard", minItemLevel: 1720, partySize: 8, supSlots: 2, dpsSlots: 6,
    title: "Tonight", startAt: new Date(Date.UTC(2026, 5, 5, 13, 0)), status: "open", skipNotify: true,
    signups,
    turns: [{ name: "Turn 1", memberIds: ["u1", "u3"] }],
    saved: 0,
    async save() { this.saved += 1; },
  };
}

function makeSelect(customId, values) {
  return {
    customId, values, user: { id: "lead" }, guildId: "g1", channelId: "c1",
    deferred: false, replied: false, edits: [],
    async deferUpdate() { this.deferred = true; },
    async editReply(payload) { this.edits.push(payload); },
  };
}

test("editing a turn keeps a member the 25-option picker could not list", async () => {
  const event = makeCrowdedEvent();
  assert.equal(event.signups.at(-1).discordId, "u3");

  // The lead ticks u1 (already in) + u2; u3 was never offered.
  await makeCommand(event).handleRaidScheduleSelect(makeSelect("rse:teammembers:0:ev1", ["u1", "u2"]));

  assert.equal(event.saved, 1);
  assert.deepEqual(event.turns[0].memberIds, ["u1", "u2", "u3"]);
});

test("a signup past #25 can be kicked from the second kick select", async () => {
  const event = makeCrowdedEvent();
  const interaction = makeSelect("rse:kickpick:1:ev1", ["u3"]);

  await makeCommand(event).handleRaidScheduleSelect(interaction);

  assert.equal(event.saved, 1);
  assert.equal(event.signups.length, 29);
  assert.equal(event.signups.some((signup) => signup.discordId === "u3"), false);
  assert.deepEqual(event.turns[0].memberIds, ["u1"]);
});
