const test = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("discord.js");

const { createRaidScheduleCommand } = require("../bot/handlers/raid/schedule");
const { UI } = require("../bot/utils/raid/common/shared");

function makeCommand(event) {
  const User = { findOne: () => ({ lean: async () => ({ language: "en" }) }) };
  const GuildConfig = { findOne: () => ({ lean: async () => null }) };
  const RaidEvent = {
    async findById(id) {
      return String(id) === String(event._id) ? event : null;
    },
  };

  return createRaidScheduleCommand({
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
    isManagerId: (id) => id === "lead",
    applyRaidSetBatchForDiscordId: async () => ({ updated: 0, failed: 0 }),
  });
}

function makeDeleteInteraction(eventId, order) {
  const channel = {
    messages: {
      async fetch() {
        return { async delete() { order.push("board"); } };
      },
    },
    async send() {
      order.push("ping");
    },
  };
  let edited = null;
  return {
    customId: `rse:delyes:${eventId}`,
    user: { id: "lead" },
    guildId: "g1",
    channelId: "c1",
    client: {
      channels: {
        async fetch() {
          return channel;
        },
      },
    },
    async deferUpdate() {
      order.push("defer");
    },
    async editReply(payload) {
      edited = payload;
      order.push("edit");
      return payload;
    },
    getEdited() {
      return edited;
    },
  };
}

test("manual delete removes the RaidEvent doc before deleting the board", async () => {
  const order = [];
  const event = {
    _id: "ev1",
    guildId: "g1",
    channelId: "c1",
    messageId: "m1",
    status: "open",
    title: "Tonight",
    signups: [{ discordId: "u1" }],
    async deleteOne() {
      order.push("doc");
    },
  };
  const command = makeCommand(event);
  const interaction = makeDeleteInteraction("ev1", order);

  await command.handleRaidScheduleButton(interaction);

  assert.ok(order.indexOf("doc") >= 0, "doc deletion ran");
  assert.ok(order.indexOf("board") >= 0, "board deletion ran");
  assert.ok(order.indexOf("doc") < order.indexOf("board"), "doc is deleted before board");
  assert.ok(order.includes("ping"), "active signups are still notified after successful delete");
});

test("manual delete leaves the board intact when RaidEvent doc deletion fails", async () => {
  const order = [];
  const event = {
    _id: "ev2",
    guildId: "g1",
    channelId: "c1",
    messageId: "m1",
    status: "open",
    title: "Tonight",
    signups: [{ discordId: "u1" }],
    async deleteOne() {
      order.push("doc");
      throw new Error("mongo offline");
    },
  };
  const command = makeCommand(event);
  const interaction = makeDeleteInteraction("ev2", order);

  await command.handleRaidScheduleButton(interaction);

  assert.deepEqual(order, ["defer", "doc", "edit"]);
  assert.equal(interaction.getEdited().embeds[0].data.title, "Couldn't delete the event");
});
