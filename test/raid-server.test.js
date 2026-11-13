"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const { UI } = require("../bot/utils/raid/common/shared");
const { t } = require("../bot/services/i18n");
const { createRaidServerCommand } = require("../bot/handlers/meta/server");
const { createRaidServerCommandDefinition } = require("../bot/handlers/commands/command-definitions/admin");

const HOME = "g-home";
const JOINED = Date.UTC(2026, 2, 2);
const FakeUser = { findOne: () => ({ lean: async () => ({ language: "en" }) }) };

function makeGuild(id, name, { leave } = {}) {
  const guild = {
    id,
    name,
    memberCount: 14,
    joinedTimestamp: JOINED,
    leaveCalls: 0,
    async leave() {
      guild.leaveCalls += 1;
      if (leave) await leave();
    },
  };
  return guild;
}

function makeClient(guilds = []) {
  return { guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) } };
}

function makeHandlers({ owner = true } = {}) {
  return createRaidServerCommand({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    UI,
    User: FakeUser,
    homeGuildId: HOME,
    isOwner: async () => owner,
  });
}

function makeCommand(client, { subcommand = "list", server = null, click = async () => makeButton("raid-server:leave:cancel") } = {}) {
  const reply = {
    awaitOptions: null,
    async awaitMessageComponent(options) {
      reply.awaitOptions = options;
      return click(options);
    },
  };
  const interaction = {
    client,
    user: { id: "owner-1", tag: "Traine" },
    deferred: 0,
    edits: [],
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => (name === "server" ? server : null),
    },
    async deferReply() { interaction.deferred += 1; },
    async editReply(payload) {
      interaction.edits.push(payload);
      return reply;
    },
    async fetchReply() { return reply; },
  };
  return { interaction, reply };
}

function makeButton(customId) {
  return { customId, user: { id: "owner-1" }, async deferUpdate() {} };
}

function makeAutocomplete(client, value = "") {
  const interaction = {
    client,
    user: { id: "owner-1" },
    responded: null,
    options: { getFocused: () => ({ name: "server", value }) },
    async respond(choices) { interaction.responded = choices; },
  };
  return interaction;
}

const embedOf = (payload) => payload.embeds[0].toJSON();
const lastEdit = (interaction) => interaction.edits.at(-1);
const titleOf = (stem) => t(`raid-server.${stem}Title`, "en");

test("a non-owner is refused for list and leave", async () => {
  const { handleRaidServerCommand } = makeHandlers({ owner: false });
  const guild = makeGuild("g-a", "Alpha");
  for (const subcommand of ["list", "leave"]) {
    const { interaction } = makeCommand(makeClient([guild]), { subcommand, server: "g-a" });
    await handleRaidServerCommand(interaction);
    assert.equal(interaction.deferred, 1);
    assert.ok(embedOf(lastEdit(interaction)).title.includes(titleOf("notOwner")), subcommand);
  }
  assert.equal(guild.leaveCalls, 0);
});

test("list puts home first and sorts the rest", async () => {
  const { handleRaidServerCommand } = makeHandlers();
  const client = makeClient([makeGuild("g-b", "Beta"), makeGuild(HOME, "Home"), makeGuild("g-a", "Alpha")]);
  const { interaction } = makeCommand(client);
  await handleRaidServerCommand(interaction);
  const lines = embedOf(lastEdit(interaction)).description.split("\n");
  assert.deepEqual(lines.map((line) => ["Home", "Alpha", "Beta"].find((name) => line.includes(name))), ["Home", "Alpha", "Beta"]);
  assert.ok(lines[0].startsWith("👑 "));
  assert.ok(lines[1].startsWith("🏠 ") && lines[2].startsWith("🏠 "));
  assert.ok(lines[1].includes("g-a") && lines[1].includes("14") && lines[1].includes(`<t:${Math.floor(JOINED / 1000)}:D>`));
});

test("list cuts long server lists", async () => {
  const { handleRaidServerCommand } = makeHandlers();
  const guilds = Array.from({ length: 200 }, (_, i) => makeGuild(`g-${i}`, `${"n".repeat(55)}${String(i).padStart(3, "0")}`));
  const { interaction } = makeCommand(makeClient(guilds));
  await handleRaidServerCommand(interaction);
  const { description } = embedOf(lastEdit(interaction));
  assert.ok(description.length <= 4096);
  const lines = description.split("\n");
  const shown = lines.length - 1;
  assert.ok(shown > 0 && shown < 200);
  assert.equal(lines.at(-1), t("raid-server.list.more", "en", { count: 200 - shown }));
});

test("suggestions answer [] for a non-owner", async () => {
  const { handleRaidServerAutocomplete } = makeHandlers({ owner: false });
  const interaction = makeAutocomplete(makeClient([makeGuild("g-a", "Alpha")]));
  await handleRaidServerAutocomplete(interaction);
  assert.deepEqual(interaction.responded, []);
});

test("suggestions hide the home guild", async () => {
  const { handleRaidServerAutocomplete } = makeHandlers();
  const interaction = makeAutocomplete(makeClient([makeGuild(HOME, "Home"), makeGuild("g-a", "Alpha")]));
  await handleRaidServerAutocomplete(interaction);
  assert.deepEqual(interaction.responded, [{ name: "🏠 Alpha", value: "g-a" }]);
});

test("suggestions match name or id without case", async () => {
  const { handleRaidServerAutocomplete } = makeHandlers();
  const client = makeClient([makeGuild("111abc222", "Other"), makeGuild("g-2", "Guild ABC"), makeGuild("g-3", "Zeta")]);
  const interaction = makeAutocomplete(client, "ABC");
  await handleRaidServerAutocomplete(interaction);
  assert.deepEqual(interaction.responded.map(({ value }) => value).sort(), ["111abc222", "g-2"]);
});

test("suggestions cap at 25 and cut labels", async () => {
  const { handleRaidServerAutocomplete } = makeHandlers();
  const many = Array.from({ length: 30 }, (_, i) => makeGuild(`g-${i}`, `Server ${String(29 - i).padStart(2, "0")}`));
  const capped = makeAutocomplete(makeClient(many));
  await handleRaidServerAutocomplete(capped);
  assert.equal(capped.responded.length, 25);
  assert.equal(capped.responded[0].name, "🏠 Server 00");

  const long = makeAutocomplete(makeClient([makeGuild("g-long", "x".repeat(120))]));
  await handleRaidServerAutocomplete(long);
  assert.equal(long.responded[0].name.length, 100);
  assert.equal(long.responded[0].value, "g-long");
});

test("leave refuses the home guild typed by id", async () => {
  const { handleRaidServerCommand } = makeHandlers();
  const home = makeGuild(HOME, "Home");
  const { interaction, reply } = makeCommand(makeClient([home]), { subcommand: "leave", server: HOME });
  await handleRaidServerCommand(interaction);
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleOf("protected")));
  assert.equal(reply.awaitOptions, null);
  assert.equal(home.leaveCalls, 0);
});

test("leave refuses an unknown id", async () => {
  const { handleRaidServerCommand } = makeHandlers();
  const { interaction } = makeCommand(makeClient([]), { subcommand: "leave", server: "g-missing" });
  await handleRaidServerCommand(interaction);
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleOf("notFound")));
});

test("leave shows the confirmation card for the invoker only", async () => {
  const { handleRaidServerCommand } = makeHandlers();
  const { interaction, reply } = makeCommand(makeClient([makeGuild("g-a", "Alpha")]), { subcommand: "leave", server: "g-a" });
  await handleRaidServerCommand(interaction);
  const card = interaction.edits[0];
  const values = embedOf(card).fields.map(({ value }) => value).join("\n");
  for (const part of ["Alpha", "g-a", "14", `<t:${Math.floor(JOINED / 1000)}:D>`]) assert.ok(values.includes(part), part);
  const ids = card.components[0].toJSON().components.map(({ custom_id: id }) => id);
  assert.deepEqual(ids, ["raid-server:leave:confirm", "raid-server:leave:cancel"]);
  assert.equal(reply.awaitOptions.filter({ user: { id: "someone-else" }, customId: "raid-server:leave:confirm" }), false);
  assert.equal(reply.awaitOptions.filter({ user: { id: "owner-1" }, customId: "raid-server:leave:confirm" }), true);
});

test("confirm leaves once and logs", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const { handleRaidServerCommand } = makeHandlers();
  const guild = makeGuild("g-a", "Alpha");
  const { interaction } = makeCommand(makeClient([guild]), {
    subcommand: "leave", server: "g-a", click: async () => makeButton("raid-server:leave:confirm"),
  });
  await handleRaidServerCommand(interaction);
  assert.equal(guild.leaveCalls, 1);
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleOf("done")));
  assert.deepEqual(lastEdit(interaction).components, []);
  assert.ok(log.mock.calls.some(({ arguments: [line] }) => line === "[raid-server] left Alpha (g-a) by Traine"));
});

test("cancel and timeout never leave", async () => {
  const { handleRaidServerCommand } = makeHandlers();
  const guild = makeGuild("g-a", "Alpha");
  const cancelled = makeCommand(makeClient([guild]), { subcommand: "leave", server: "g-a" });
  await handleRaidServerCommand(cancelled.interaction);
  assert.ok(embedOf(lastEdit(cancelled.interaction)).title.includes(titleOf("cancelled")));
  assert.deepEqual(lastEdit(cancelled.interaction).components, []);

  const timedOut = makeCommand(makeClient([guild]), {
    subcommand: "leave", server: "g-a", click: async () => { throw new Error("time"); },
  });
  await handleRaidServerCommand(timedOut.interaction);
  assert.ok(embedOf(lastEdit(timedOut.interaction)).title.includes(titleOf("expired")));
  assert.equal(guild.leaveCalls, 0);
});

test("confirm after the guild vanished does not leave", async () => {
  const { handleRaidServerCommand } = makeHandlers();
  const guild = makeGuild("g-a", "Alpha");
  const client = makeClient([guild]);
  const { interaction } = makeCommand(client, {
    subcommand: "leave",
    server: "g-a",
    click: async () => {
      client.guilds.cache.delete("g-a");
      return makeButton("raid-server:leave:confirm");
    },
  });
  await handleRaidServerCommand(interaction);
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleOf("notFound")));
  assert.equal(guild.leaveCalls, 0);
});

test("a throwing leave shows the failed card", async (t) => {
  t.mock.method(console, "error", () => {});
  const { handleRaidServerCommand } = makeHandlers();
  const guild = makeGuild("g-a", "Alpha", { leave: async () => { throw new Error("Missing Access"); } });
  const { interaction } = makeCommand(makeClient([guild]), {
    subcommand: "leave", server: "g-a", click: async () => makeButton("raid-server:leave:confirm"),
  });
  await handleRaidServerCommand(interaction);
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleOf("failed")));
});

test("the registered definition hides the command from members", () => {
  const json = createRaidServerCommandDefinition().toJSON();
  assert.equal(json.name, "raid-server");
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.equal(json.dm_permission, false);
  const leave = json.options.find(({ name }) => name === "leave");
  const server = leave.options.find(({ name }) => name === "server");
  assert.equal(server.required, true);
  assert.equal(server.autocomplete, true);
  assert.ok(json.options.some(({ name }) => name === "list"));
});

// An unavailable guild (a Discord outage at ready) carries only its id.
function makeUnavailableGuild(id) {
  const guild = { id, available: false, leaveCalls: 0, async leave() { guild.leaveCalls += 1; } };
  return guild;
}

test("list and suggestions keep working when a guild is unavailable", async () => {
  const { handleRaidServerCommand, handleRaidServerAutocomplete } = makeHandlers();
  const client = makeClient([makeGuild("g-a", "Alpha"), makeUnavailableGuild("g-x")]);
  const { interaction } = makeCommand(client);
  await handleRaidServerCommand(interaction);
  const { description } = embedOf(lastEdit(interaction));
  assert.ok(description.includes("g-x"));
  assert.ok(!description.includes("NaN") && !description.includes("undefined"));

  const suggestions = makeAutocomplete(client);
  await handleRaidServerAutocomplete(suggestions);
  assert.deepEqual(suggestions.responded, [
    { name: "🏠 Alpha", value: "g-a" },
    { name: "🏠 g-x", value: "g-x" },
  ]);
});

test("leave refuses the home guild when GUILD_ID carries quotes or spaces", async () => {
  const { handleRaidServerCommand, handleRaidServerAutocomplete } = createRaidServerCommand({
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, UI,
    User: FakeUser, homeGuildId: ` "${HOME}" `, isOwner: async () => true,
  });
  const home = makeGuild(HOME, "Home");
  const client = makeClient([home, makeGuild("g-a", "Alpha")]);
  const { interaction } = makeCommand(client, { subcommand: "leave", server: HOME });
  await handleRaidServerCommand(interaction);
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleOf("protected")));
  assert.equal(home.leaveCalls, 0);

  const suggestions = makeAutocomplete(client);
  await handleRaidServerAutocomplete(suggestions);
  assert.deepEqual(suggestions.responded.map(({ value }) => value), ["g-a"]);
});

test("suggestion labels never end in half an emoji", async () => {
  const { handleRaidServerAutocomplete } = makeHandlers();
  // "🏠 " takes 3 UTF-16 units, so the emoji straddles the 100-unit cut.
  const interaction = makeAutocomplete(makeClient([makeGuild("g-1", `${"x".repeat(96)}😀`)]));
  await handleRaidServerAutocomplete(interaction);
  assert.equal(interaction.responded[0].name, `🏠 ${"x".repeat(96)}`);
});

test("a stranger-set server name is escaped in the list and on the cards", async (t) => {
  t.mock.method(console, "log", () => {});
  const { handleRaidServerCommand } = makeHandlers();
  const client = makeClient([makeGuild("g-a", "[x](https://evil.test) **b**")]);
  const escaped = String.raw`\[x\](https://evil.test) \*\*b\*\*`;

  const listed = makeCommand(client);
  await handleRaidServerCommand(listed.interaction);
  const shownList = embedOf(lastEdit(listed.interaction)).description;
  assert.ok(shownList.includes(escaped) && !shownList.includes("[x](https://evil.test)"), shownList);

  const left = makeCommand(client, {
    subcommand: "leave", server: "g-a", click: async () => makeButton("raid-server:leave:confirm"),
  });
  await handleRaidServerCommand(left.interaction);
  for (const payload of [left.interaction.edits[0], lastEdit(left.interaction)]) {
    const card = embedOf(payload);
    const shown = [card.description, ...(card.fields || []).map(({ value }) => value)].join("\n");
    assert.ok(shown.includes(escaped) && !shown.includes("[x](https://evil.test)"), shown);
  }
});
