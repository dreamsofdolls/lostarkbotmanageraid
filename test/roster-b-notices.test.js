"use strict";

// B notices on /raid-add-roster, /raid-edit-roster, /raid-remove-roster and
// /raid-gold-earner.

process.env.RAID_MANAGER_ID = "manager-1";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { createAddRosterCommand } = require("../bot/handlers/roster/add");
const { createEditRosterCommand } = require("../bot/handlers/roster/edit");
const { createRemoveRosterCommand } = require("../bot/handlers/roster/remove");
const { createRaidGoldEarnerCommand } = require("../bot/handlers/roster/gold-earner");
const {
  UI,
  buildNoticeEmbed,
  normalizeName,
  parseCombatScore,
  getCharacterName,
  getCharacterClass,
} = require("../bot/utils/raid/common/shared");
const { buildCharacterRecord, createCharacterId } = require("../bot/utils/raid/common/character");
const { clearUserLanguageCache, t } = require("../bot/services/i18n");

const icon = (kind) => buildNoticeEmbed(EmbedBuilder, { kind, title: "x" }).toJSON().title.slice(0, -1);
const detailName = t("common.fields.details", "vi");

// A User model over one in-memory doc: `findOne()` is awaitable for a live
// doc with save(), and `.lean()` gives the plain copy.
function userModel(initial) {
  let stored = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    findOne() {
      const live = () => (stored ? { ...JSON.parse(JSON.stringify(stored)), async save() { stored = JSON.parse(JSON.stringify({ ...this, save: undefined })); } } : null);
      return {
        lean: async () => (stored ? JSON.parse(JSON.stringify(stored)) : null),
        then: (resolve, reject) => Promise.resolve(live()).then(resolve, reject),
      };
    },
  };
}

const rosterDeps = (User, overrides = {}) => ({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  saveWithRetry: async (op) => op(),
  ensureFreshWeek: () => false,
  MAX_CHARACTERS_PER_ACCOUNT: 25,
  fetchRosterCharacters: async () => [],
  parseCombatScore,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  buildCharacterRecord,
  createCharacterId,
  isManagerId: (id) => id === "manager-1",
  loadUserForAutocomplete: async () => null,
  ...overrides,
});

function recorder(extra = {}) {
  const calls = [];
  return {
    calls,
    interaction: {
      user: { id: "user-1" },
      async reply(payload) { calls.push({ via: "reply", payload }); },
      async deferReply(payload) { calls.push({ via: "deferReply", payload }); },
      async deferUpdate() { calls.push({ via: "deferUpdate" }); },
      async editReply(payload) { calls.push({ via: "editReply", payload }); },
      async update(payload) { calls.push({ via: "update", payload }); },
      ...extra,
    },
  };
}

const lastEmbed = (calls) => {
  const payload = calls.filter((call) => call.payload?.embeds).at(-1).payload;
  return payload.embeds[0].toJSON();
};

const character = (name) => ({
  id: `${name}-id`,
  name,
  class: "Bard",
  itemLevel: 1700,
  assignedRaids: { armoche: {}, kazeros: {}, serca: {} },
  tasks: [],
});

test("edit-roster not found keeps the C+ title in the B frame", async () => {
  clearUserLanguageCache();
  const User = userModel({ discordId: "user-1", accounts: [{ accountName: "Perfectwings", characters: [] }] });
  const { handleEditRosterCommand } = createEditRosterCommand(rosterDeps(User));
  const { calls, interaction } = recorder({ options: { getString: () => "Vencone" } });

  await handleEditRosterCommand(interaction);

  const embed = lastEmbed(calls);
  assert.equal(embed.title, `${icon("empty")}Không thấy roster · ❓ Vencone`);
  assert.equal(embed.color, UI.colors.neutral);
  assert.ok(embed.footer?.text.startsWith("💡 "), embed.footer?.text);
  assert.ok(embed.timestamp);
});

test("a C+ notice with two next steps keeps both", async () => {
  clearUserLanguageCache();
  const User = userModel({
    discordId: "user-1",
    accounts: [{ accountName: "Perfectwings", characters: [character("Perfectwings")] }],
  });
  const { handleAddRosterCommand } = createAddRosterCommand(rosterDeps(User));
  const { calls, interaction } = recorder({ options: { getString: () => "Perfectwings", getUser: () => null } });

  await handleAddRosterCommand(interaction);

  const embed = lastEmbed(calls);
  assert.ok(embed.title.startsWith(icon("input")), embed.title);
  // First next step: the tip.
  assert.match(embed.footer?.text || "", /\/raid-edit-roster/);
  assert.match(embed.footer?.text || "", /Perfectwings/);
  // Second next step: a sentence in the description, no bullet list.
  assert.match(embed.description, /\/raid-remove-roster/);
  assert.match(embed.description, /\/raid-add-roster/);
  assert.doesNotMatch(embed.description, /•|\/raid-edit-roster/);
});

test("remove-roster not found is the same kind for roster and character", async () => {
  clearUserLanguageCache();
  const results = [];
  for (const options of [
    { roster: "Charlie", action: "remove_roster" },
    { roster: "Alpha", action: "remove_char", character: "Bardella" },
  ]) {
    const User = userModel({ discordId: "user-1", accounts: [{ accountName: "Alpha", characters: [character("Cyrano")] }] });
    const { handleRemoveRosterCommand } = createRemoveRosterCommand(rosterDeps(User));
    const { calls, interaction } = recorder({ options: { getString: (name) => options[name] ?? null } });
    await handleRemoveRosterCommand(interaction);
    results.push(lastEmbed(calls));
  }
  for (const embed of results) {
    assert.ok(embed.title.startsWith(icon("empty")), embed.title);
    assert.equal(embed.color, UI.colors.neutral);
  }

  // A roster name past the title limit is clamped on the removed card.
  const longName = "x".repeat(300);
  const User = userModel({ discordId: "user-1", accounts: [{ accountName: longName, characters: [character("Cyrano")] }] });
  const { handleRemoveRosterCommand } = createRemoveRosterCommand(rosterDeps(User));
  const options = { roster: longName, action: "remove_roster" };
  const { calls, interaction } = recorder({ options: { getString: (name) => options[name] ?? null } });
  await handleRemoveRosterCommand(interaction);
  const removed = lastEmbed(calls);
  assert.ok(removed.title.startsWith(icon("done")), removed.title);
  assert.ok(removed.title.length <= 256, String(removed.title.length));
});

test("add-roster failure stays public and clears the picker", async () => {
  clearUserLanguageCache();
  const User = userModel(null);
  const { handleAddRosterButton, __test } = createAddRosterCommand(rosterDeps(User, {
    saveWithRetry: async () => { throw new Error("write conflict on accounts.3"); },
  }));
  __test.sessions.set("sess-fail", {
    sessionId: "sess-fail",
    callerId: "user-1",
    targetId: null,
    discordId: "user-1",
    actingForOther: false,
    lang: "vi",
    seedCharName: "Wingsalt",
    bibleNames: new Set(["wingsalt"]),
    chars: [{ charName: "Wingsalt", className: "Bard", itemLevel: 1700, combatScore: "80000" }],
    selectedIndices: new Set([0]),
    expireTimer: null,
  });
  const { calls, interaction } = recorder({ customId: "add-roster:confirm:sess-fail" });

  await handleAddRosterButton(interaction);

  const edit = calls.filter((call) => call.via === "editReply").at(-1).payload;
  assert.equal(edit.content, null);
  assert.deepEqual(edit.components, []);
  assert.equal("flags" in edit, false);
  const embed = edit.embeds[0].toJSON();
  assert.ok(embed.title.startsWith(icon("failure")), embed.title);
  assert.doesNotMatch(embed.description, /write conflict/);
  assert.match(embed.fields?.find((field) => field.name === detailName)?.value || "", /write conflict on accounts\.3/);
});

test("gold-earner stale picker is expired", async () => {
  clearUserLanguageCache();
  const { handleRaidGoldEarnerButton } = createRaidGoldEarnerCommand(rosterDeps(userModel(null)));
  const { calls, interaction } = recorder({ customId: "gold-earner:confirm:gone" });

  await handleRaidGoldEarnerButton(interaction);

  const embed = lastEmbed(calls);
  assert.ok(embed.title.startsWith(icon("expired")), embed.title);
  assert.equal(embed.color, UI.colors.muted);
  assert.ok(embed.footer?.text.startsWith("💡 "), embed.footer?.text);
});

test("a picker pressed by someone else is guard with a tip", async () => {
  clearUserLanguageCache();
  const { handleAddRosterButton, __test } = createAddRosterCommand(rosterDeps(userModel(null)));
  __test.sessions.set("sess-owner", {
    sessionId: "sess-owner",
    callerId: "user-1",
    lang: "vi",
    chars: [],
    selectedIndices: new Set(),
  });
  const { calls, interaction } = recorder({ customId: "add-roster:confirm:sess-owner", user: { id: "user-2" } });

  await handleAddRosterButton(interaction);

  const embed = lastEmbed(calls);
  assert.ok(embed.title.startsWith(icon("guard")), embed.title);
  assert.equal(embed.color, UI.colors.progress);
  assert.ok(embed.footer?.text.startsWith("💡 "), embed.footer?.text);
});
