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

function matchesQuery(board, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === "object" && Array.isArray(expected.$in)) {
      return expected.$in.includes(board[key]);
    }
    return String(board[key]) === String(expected);
  });
}

function makeCommand(boards) {
  const User = { findOne: () => ({ lean: async () => ({ language: "en" }) }) };
  const GuildConfig = { findOne: () => ({ lean: async () => null }) };
  const RaidEvent = {
    find: (query) => queryResult(boards.filter((board) => matchesQuery(board, query))),
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

// Channel stub whose send/delete methods record call order for verifying the
// anti-ghost invariant (post the new board BEFORE deleting the old one).
function makeChannel(order, options = {}) {
  const sentPayloads = options.sentPayloads || [];
  return {
    async send(payload) {
      sentPayloads.push(payload);
      order.push("send");
      return {
        id: "new-msg",
        url: "https://discord/new-msg",
        async delete() { order.push("delete-new"); },
      };
    },
    messages: {
      async fetch(id) {
        return {
          async delete() { order.push(id === "new-msg" ? "delete-new-fetch" : "delete"); },
        };
      },
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
    options: { getSubcommand: () => "show", getString: () => null },
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
    options: { getSubcommand: () => "show", getString: () => null },
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    async reply(payload) { replied = payload; return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.match(replied.embeds[0].data.title, /no active boards/i);
});

test("show ignores active boards from another guild", async () => {
  const order = [];
  const foreign = makeBoard({ _id: "foreign", guildId: "g2", channelId: "c2", order });
  const command = makeCommand([foreign]);
  let replied = null;
  const interaction = {
    options: { getSubcommand: () => "show", getString: () => null },
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    async reply(payload) { replied = payload; return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.match(replied.embeds[0].data.title, /no active boards/i);
  assert.equal(order.includes("send"), false, "foreign-guild board was not reposted");
});

test("show is manager-gated: a non-manager is rejected, no board is touched", async () => {
  const order = [];
  const board = makeBoard({ order });
  const command = makeCommand([board]);
  let replied = null;
  const interaction = {
    options: { getSubcommand: () => "show", getString: () => null },
    user: { id: "rando" }, guildId: "g1", channelId: "c1",
    async reply(payload) { replied = payload; return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.ok(replied, "a notice was sent");
  assert.equal(order.includes("send"), false, "no board was reposted");
});

test("show leaves the old board intact when messageId persistence fails", async () => {
  const order = [];
  const board = makeBoard({
    order,
    async save() { order.push("save"); throw new Error("mongo offline"); },
  });
  const command = makeCommand([board]);
  const channel = makeChannel(order);
  let edited = null;
  const interaction = {
    options: { getSubcommand: () => "show", getString: () => null },
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    client: { channels: { async fetch() { return channel; } } },
    async deferReply() { order.push("defer"); },
    async editReply(payload) { edited = payload; order.push("edit"); return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.equal(board.messageId, "old-msg", "messageId restored to the old board");
  assert.equal(order.includes("send"), true, "fresh board was posted before save failed");
  assert.equal(order.includes("delete"), false, "old board was not deleted after save failed");
  assert.equal(order.includes("delete-new"), true, "fresh orphan board was cleaned up best-effort");
  assert.match(edited.embeds[0].data.title, /couldn't bump/i);
});

test("resurfaced boards do not show switcher options from another guild or channel", async () => {
  const order = [];
  const sentPayloads = [];
  const current = makeBoard({ _id: "cur1", guildId: "g1", channelId: "c1", order });
  const foreign = makeBoard({ _id: "foreign2", guildId: "g2", channelId: "c2", title: "Other guild", order });
  const otherChannel = makeBoard({ _id: "chan2", guildId: "g1", channelId: "c2", title: "Other channel", order });
  const command = makeCommand([current, foreign, otherChannel]);
  const channel = makeChannel(order, { sentPayloads });
  const interaction = {
    options: { getSubcommand: () => "show", getString: () => null },
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    client: { channels: { async fetch() { return channel; } } },
    async deferReply() { order.push("defer"); },
    async editReply(payload) { order.push("edit"); return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].components.length, 2, "only the normal board rows render");
  const customIds = sentPayloads[0].components.flatMap((row) => row.components.map((component) => component.data.custom_id));
  assert.equal(customIds.some((id) => id.startsWith("rse:showpick:")), false);
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

test("the board switcher switches the current message in place for its creator", async () => {
  const order = [];
  const current = makeBoard({ _id: "cur1", channelId: "c1", order });
  const other = makeBoard({ _id: "other2", channelId: "c1", messageId: "old2", title: "Echidna", order });
  const command = makeCommand([current, other]);
  const channel = makeChannel(order);
  let edited = null;
  let followed = null;
  const interaction = {
    customId: "rse:showpick:cur1",
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    values: ["other2"],
    message: { id: "old-msg" },
    client: { channels: { async fetch() { return channel; } } },
    async deferUpdate() { order.push("defer"); },
    async editReply(payload) { edited = payload; order.push("edit"); return payload; },
    async followUp(payload) { followed = payload; return payload; },
  };

  await command.handleRaidScheduleSelect(interaction);

  assert.equal(other.messageId, "old-msg", "the chosen board now owns the visible message");
  assert.equal(current.messageId, null, "the previous board no longer points at the visible message");
  assert.equal(order.includes("send"), false, "switching does not post a second board");
  assert.equal(order.includes("edit"), true, "the current message was edited in place");
  assert.equal(order.includes("delete"), true, "the chosen board's old message was removed best-effort");
  assert.equal(followed, null, "no extra notice is needed when the message visibly switches");
  assert.match(edited.embeds[0].data.title, /Echidna/);
});

test("the board switcher refuses a chosen board from another guild", async () => {
  const order = [];
  const current = makeBoard({ _id: "cur1", guildId: "g1", channelId: "c1", order });
  const foreign = makeBoard({ _id: "foreign2", guildId: "g2", channelId: "c2", title: "Other guild", order });
  const command = makeCommand([current, foreign]);
  let followed = null;
  const interaction = {
    customId: "rse:showpick:cur1",
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    values: ["foreign2"],
    async deferUpdate() { order.push("defer"); },
    async followUp(payload) { followed = payload; return payload; },
  };

  await command.handleRaidScheduleSelect(interaction);

  assert.ok(followed, "a stale/missing notice was sent");
  assert.equal(foreign.messageId, "old-msg", "foreign-guild board was not repointed");
  assert.equal(order.includes("send"), false, "foreign-guild board was not reposted");
});

test("the board switcher refuses a chosen board from another channel", async () => {
  const order = [];
  const current = makeBoard({ _id: "cur1", guildId: "g1", channelId: "c1", order });
  const otherChannel = makeBoard({ _id: "chan2", guildId: "g1", channelId: "c2", title: "Other channel", order });
  const command = makeCommand([current, otherChannel]);
  let followed = null;
  const interaction = {
    customId: "rse:showpick:cur1",
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    values: ["chan2"],
    async deferUpdate() { order.push("defer"); },
    async followUp(payload) { followed = payload; return payload; },
  };

  await command.handleRaidScheduleSelect(interaction);

  assert.ok(followed, "a stale/missing notice was sent");
  assert.equal(otherChannel.messageId, "old-msg", "other-channel board was not repointed");
  assert.equal(order.includes("send"), false, "other-channel board was not reposted");
});

test("show action:turnplan opens an ephemeral dashboard (current-channel board + own-board switcher)", async () => {
  const a = makeBoard({ _id: "evA", channelId: "c1", title: "Act 4", turns: [{ name: "Turn 1", memberIds: [] }] });
  const b = makeBoard({ _id: "evB", channelId: "c9", title: "Serca", turns: [] });
  const command = makeCommand([a, b]);
  let replied = null;
  const interaction = {
    options: { getSubcommand: () => "show", getString: (n) => (n === "action" ? "turnplan" : null) },
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    async reply(payload) { replied = payload; return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.ok(replied, "an ephemeral dashboard was sent");
  assert.match(replied.embeds[0].data.author.name, /TURN PLAN/);
  assert.match(replied.embeds[0].data.title, /Act 4/, "defaults to the board in the current channel");
  const ids = replied.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
  assert.ok(ids.includes("rse:showtp:evA"), "carries the own-board switcher");
});

test("show action:turnplan with no boards tells the lead to create one first", async () => {
  const command = makeCommand([]);
  let replied = null;
  const interaction = {
    options: { getSubcommand: () => "show", getString: () => "turnplan" },
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    async reply(payload) { replied = payload; return payload; },
  };

  await command.handleRaidScheduleCommand(interaction);

  assert.match(replied.embeds[0].data.title, /no active boards/i);
});

test("the turn-plan switcher swaps the ephemeral to the chosen own board", async () => {
  const a = makeBoard({ _id: "evA", channelId: "c1", title: "Act 4", turns: [] });
  const b = makeBoard({ _id: "evB", channelId: "c9", title: "Serca", turns: [{ name: "Turn 1", memberIds: [] }] });
  const command = makeCommand([a, b]);
  let edited = null;
  const interaction = {
    customId: "rse:showtp:evA",
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    values: ["evB"],
    async deferUpdate() {},
    async editReply(payload) { edited = payload; return payload; },
  };

  await command.handleRaidScheduleSelect(interaction);

  assert.ok(edited, "the ephemeral was edited in place");
  assert.match(edited.embeds[0].data.title, /Serca/, "swapped to the chosen board's turn plan");
});

test("the turn-plan switcher refuses a board the clicker did not create", async () => {
  const mine = makeBoard({ _id: "evA", channelId: "c1", title: "Act 4" });
  const foreign = makeBoard({ _id: "evX", creatorId: "someone-else", title: "Not yours" });
  const command = makeCommand([mine, foreign]);
  let edited = null;
  const interaction = {
    customId: "rse:showtp:evA",
    user: { id: "lead" }, guildId: "g1", channelId: "c1",
    values: ["evX"],
    async deferUpdate() {},
    async editReply(payload) { edited = payload; return payload; },
  };

  await command.handleRaidScheduleSelect(interaction);

  assert.ok(edited, "a denial/stale notice was sent");
  assert.doesNotMatch(edited.embeds[0].data.title || "", /Not yours/, "did not render the foreign board");
});
