"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { escapeEmbedText } = require("../bot/utils/discord/embed-text");
const { buildShareRefusalNotice } = require("../bot/handlers/raid/task/notices");
const { buildAccountTaskFields } = require("../bot/utils/raid/tasks/task-view");

const MASKED_LINK = "[Claim](https://x.example)";
const ESCAPED_LINK = "\\[Claim\\](https://x.example)";

test("escapeEmbedText escapes markdown and the brackets of a masked link", () => {
  assert.equal(escapeEmbedText(MASKED_LINK), ESCAPED_LINK);
  assert.equal(escapeEmbedText("**a**"), "\\*\\*a\\*\\*");
  assert.equal(escapeEmbedText("Mira"), "Mira");
  assert.equal(escapeEmbedText(undefined), "");
});

test("share refusal notice shows the owner's name as text, not a link", () => {
  const notice = buildShareRefusalNotice("viewOnly", { ownerLabel: MASKED_LINK }, "en");
  assert.ok(notice.description.includes(ESCAPED_LINK), notice.description);
});

test("task view shows a task name as text, not a link", () => {
  const account = {
    characters: [{ name: "Aki", class: "Bard", itemLevel: 1700, sideTasks: [{ taskId: "1", name: MASKED_LINK, reset: "daily" }] }],
  };
  const { fields } = buildAccountTaskFields(account, { UI: { icons: { done: "D", pending: "P" } }, truncateText: (s) => s });
  const values = fields.map((field) => field.value).join("\n");
  assert.ok(values.includes(`P ${ESCAPED_LINK}`), values);
});

const { EmbedBuilder } = require("discord.js");
const { addTaskViewContent } = require("../bot/utils/raid/tasks/task-view");
const { createRaidSetResultResponder } = require("../bot/handlers/raid/set/command-result");
const { createRaidShareCommand } = require("../bot/handlers/raid/share");
const { UI } = require("../bot/utils/raid/common/shared");
const { clearUserLanguageCache } = require("../bot/services/i18n");

// Echoes a key and its vars, so a test reads what each name became.
const echo = (key, lang, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const anyText = new Proxy({}, { get: () => () => "x" });

test("the shared task field shows a custom task name as text", () => {
  const embed = new EmbedBuilder();
  addTaskViewContent({
    embed, fields: [], totals: {}, sharedTasks: [{}], now: Date.now(), lang: "en", UI: { icons: { done: "D", pending: "P" } },
    getSharedTaskDisplay: () => ({ completed: false, emoji: "E", name: MASKED_LINK, status: "s" }),
    truncateText: (s) => s, text: anyText,
  });
  const value = embed.toJSON().fields[0].value;
  assert.ok(value.includes(`**${ESCAPED_LINK}**`), value);
});

test("the ambiguous roster notice shows each owner's name as text", async () => {
  const notices = [];
  const { replyRosterOwnerFailure } = createRaidSetResultResponder({ EmbedBuilder, UI, t: echo });
  await replyRosterOwnerFailure({
    replySetNotice: async (notice) => { notices.push(notice); },
    resolvedOwner: { ambiguous: true, matches: [{ ownerLabel: MASKED_LINK }, { ownerLabel: "Bao" }] },
    lang: "en", rosterName: "Vencone",
  });
  assert.ok(JSON.parse(notices[0].description.slice(notices[0].description.indexOf("{"))).ownerNames.startsWith(ESCAPED_LINK), notices[0].description);
});

test("the incoming shares list shows the owner's name as text", async (t) => {
  const User = require("../bot/models/user");
  const RosterShare = require("../bot/models/RosterShare");
  t.mock.method(User, "findOne", () => ({ lean: async () => ({ language: "en" }), select() { return this; } }));
  t.mock.method(User, "find", () => ({ lean: async () => [{ discordId: "owner-1", discordDisplayName: MASKED_LINK }] }));
  t.mock.method(RosterShare, "find", () => ({ lean: async () => [{ ownerDiscordId: "owner-1", accessLevel: "view" }] }));
  clearUserLanguageCache();
  t.after(() => clearUserLanguageCache());
  const edits = [];
  const { handleRaidShareCommand } = createRaidShareCommand({ EmbedBuilder, UI });
  await handleRaidShareCommand({
    user: { id: "member-1" },
    options: { getSubcommand: () => "list", getString: (name) => (name === "direction" ? "in" : null) },
    deferReply: async () => {}, editReply: async (payload) => { edits.push(payload); }, reply: async (payload) => { edits.push(payload); },
  });
  const text = JSON.stringify(edits.at(-1).embeds[0].toJSON ? edits.at(-1).embeds[0].toJSON() : edits.at(-1).embeds[0]);
  assert.equal(text.includes(JSON.stringify(MASKED_LINK).slice(1, -1)), false, text);
});
