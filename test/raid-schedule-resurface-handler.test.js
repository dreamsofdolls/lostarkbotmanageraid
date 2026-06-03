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

// A Mongoose-ish query stub: chainable .sort(), awaitable directly (handleShow
// awaits find().sort()), and .lean()-able (boardPayload uses find().sort().lean()).
function queryResult(arr) {
  return {
    sort() { return this; },
    lean() { return Promise.resolve(arr); },
    then(resolve, reject) { return Promise.resolve(arr).then(resolve, reject); },
  };
}

function makeCommand(boards) {
  const User = { findOne: () => ({ lean: async () => ({ language: "en" }) }) };
  const GuildConfig = { findOne: () => ({ lean: async () => null }) };
  const RaidEvent = {
    find: () => queryResult(boards),
    async findById(id) {
      return boards.find((b) => String(b._id) === String(id)) || null;
    },
  };
  return createRaidScheduleCommand({
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
    UI, User, GuildConfig, RaidEvent,
    isManagerId: (id) => id === "lead",
    applyRaidSetBatchForDiscordId: async () => [],
  });
}

function makeBoard(overrides = {}) {
  const order = overrides.order || [];
  return {
    _id: "ev1", guildId: "g1", channelId: "c1", messageId: "old-msg", creatorId: "lead",
    raidKey: "armoche", modeKey: "hard", minItemLevel: 1720,
    partySize: 8, supSlots: 2, dpsSlots: 6, title: "Tonight",
    startAt: new Date(Date.UTC(2026, 5, 5, 13, 0)), status: "open", signups: [],
    async save() { order.push("save"); },
    ...overrides,
  };
}

// A channel whose send/delete record their call order, so we can assert the
// anti-ghost invariant (post the new board BEFORE deleting the old one).
function makeChannel(order) {
  return {
    async send() { order.push("send"); return { id: "new-msg", url: "https://discord/new-msg" }; },
    messages: {
      async fetch() { return { async delete() { order.push("delete"); } }; },
    },
  };
}

test("show resurfaces the board: post new -> repoint messageId -> delete old (anti-ghost order)", async () => {
  const order = [];
  const board = makeBoard({ order });
  const command = makeCommand([board]);
  const channel = makeChannel(order);
  let edited = null;
  const interaction = {
    options: { getSubcommand: () => "show" },
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    client: { channels: { async fetch() { return channel; } } },
    async deferReply() { order.push("defer"); },
    async editReply(payload) { edited = payload; order.push("edit"); return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.equal(board.messageId, "new-msg", "messageId repointed to the fresh board");
  assert.ok(order.indexOf("send") < order.indexOf("delete"), "new board posted before old is deleted");
  assert.ok(order.indexOf("save") < order.indexOf("delete"), "messageId persisted before old is deleted");
  assert.match(edited.embeds[0].data.title, /bumped/i);
});

test("show with no active boards tells the lead to create one first", async () => {
  const command = makeCommand([]);
  let replied = null;
  const interaction = {
    options: { getSubcommand: () => "show" },
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    async reply(payload) { replied = payload; return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.match(replied.embeds[0].data.title, /no active boards/i);
});

test("show is manager-gated: a non-manager is rejected, no board is touched", async () => {
  const order = [];
  const board = makeBoard({ order });
  const command = makeCommand([board]);
  let replied = null;
  const interaction = {
    options: { getSubcommand: () => "show" },
    user: { id: "rando" }, guildId: "g1", channelId: "c1",
    async reply(payload) { replied = payload; return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.ok(replied, "a notice was sent");
  assert.equal(order.includes("send"), false, "no board was reposted");
});

test("the board switcher rejects anyone who is not the boards' creator", async () => {
  const order = [];
  const current = makeBoard({ _id: "cur1", order });
  const command = makeCommand([current]);
  let followed = null;
  const interaction = {
    customId: "rse:showpick:cur1",
    user: { id: "intruder" }, guildId: "g1", channelId: "c1",
    values: ["cur1"],
    async deferUpdate() { order.push("defer"); },
    async followUp(payload) { followed = payload; return payload; },
  };

  await command.handleRaidScheduleSelect(interaction);

  assert.ok(followed, "a denial notice was sent");
  assert.match(followed.embeds[0].data.title, /lead/i);
  assert.equal(order.includes("send"), false, "no board was reposted for the intruder");
});

test("the board switcher resurfaces the chosen board for its creator", async () => {
  const order = [];
  const current = makeBoard({ _id: "cur1", channelId: "c1", order });
  const other = makeBoard({ _id: "other2", channelId: "c2", messageId: "old2", title: "Echidna", order });
  const command = makeCommand([current, other]);
  const channel = makeChannel(order);
  let followed = null;
  const interaction = {
    customId: "rse:showpick:cur1",
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    values: ["other2"],
    client: { channels: { async fetch() { return channel; } } },
    async deferUpdate() { order.push("defer"); },
    async followUp(payload) { followed = payload; return payload; },
  };

  await command.handleRaidScheduleSelect(interaction);

  assert.equal(other.messageId, "new-msg", "the chosen board was repointed");
  assert.equal(current.messageId, "old-msg", "the board the switcher sat on is untouched");
  assert.ok(order.indexOf("send") < order.indexOf("delete"), "post before delete on the chosen board");
  assert.match(followed.embeds[0].data.title, /bumped/i);
});
