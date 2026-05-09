// Tests for /raid-help.
//
// All output is rendered via discord.js builders, so tests assert on
// embed JSON shape after driving the handler with a mock interaction.
// Coverage focuses on: correct dropdown population, detail-embed
// resolution by section key, fallback for invalid keys, and the
// 1024-char field-chunking that protects against Discord rejection on
// over-long notes.

process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  MessageFlags,
} = require("discord.js");

const { createRaidHelpCommand } = require("../bot/handlers/raid-help");
const { UI } = require("../bot/utils/raid/shared");

function makeFactory() {
  return createRaidHelpCommand({
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    MessageFlags,
    UI,
    // DI stub: skip the Mongo round-trip that the production
    // resolveStoredLanguage default would do. Tests run without a live
    // mongoose connection so a real User.findOne would hang the suite.
    resolveStoredLanguage: async () => "vi",
  });
}

function makeReplyInteraction({ language = null } = {}) {
  const calls = { reply: [], update: [] };
  return {
    user: { id: "user-1" },
    options: {
      getString: (name) => (name === "language" ? language : null),
    },
    reply: async (arg) => {
      calls.reply.push(arg);
    },
    update: async (arg) => {
      calls.update.push(arg);
    },
    _calls: calls,
  };
}

function makeSelectInteraction(value, { lang = "vi" } = {}) {
  const interaction = makeReplyInteraction();
  interaction.values = value == null ? [] : [value];
  // CustomId now carries the lang suffix from buildHelpDropdown.
  interaction.customId = `raid-help:select:${lang}`;
  return interaction;
}

function getAllFieldValues(embedJson) {
  return (embedJson.fields || []).map((f) => f.value).join("\n");
}

const EXPECTED_SECTION_KEYS = [
  "getting-started",
  "raid-add-roster",
  "raid-edit-roster",
  "raid-status",
  "raid-gold-earner",
  "raid-task",
  "raid-set",
  "raid-check",
  "raid-remove-roster",
  "raid-channel",
  "raid-auto-manage",
  "raid-announce",
  "raid-language",
];

test("handleRaidHelpCommand: replies with overview embed + dropdown, ephemeral", async () => {
  const factory = makeFactory();
  const interaction = makeReplyInteraction();
  await factory.handleRaidHelpCommand(interaction);

  assert.equal(interaction._calls.reply.length, 1);
  const reply = interaction._calls.reply[0];
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.ok(reply.embeds[0]);
  assert.ok(reply.components[0]);

  const embedJson = reply.embeds[0].toJSON();
  assert.match(embedJson.title, /Raid Management Bot/i);
  // Overview field per section.
  assert.equal(embedJson.fields.length, EXPECTED_SECTION_KEYS.length);
});

test("dropdown contains every help section + bakes default lang into customId", async () => {
  const factory = makeFactory();
  const interaction = makeReplyInteraction();
  await factory.handleRaidHelpCommand(interaction);

  const row = interaction._calls.reply[0].components[0].toJSON();
  const select = row.components[0];
  assert.equal(select.custom_id, "raid-help:select:vi", "default lang is vi");
  const optionValues = select.options.map((o) => o.value).sort();
  assert.deepEqual(optionValues, [...EXPECTED_SECTION_KEYS].sort());
});

test("language=en option renders English overview + bakes en into dropdown customId", async () => {
  const factory = makeFactory();
  const interaction = makeReplyInteraction({ language: "en" });
  await factory.handleRaidHelpCommand(interaction);

  const reply = interaction._calls.reply[0];
  const embedJson = reply.embeds[0].toJSON();
  // Title carries lang code suffix.
  assert.match(embedJson.title, /\(EN\)/);
  // Description in English.
  assert.match(embedJson.description, /Lost Ark raid progress tracker/);
  assert.doesNotMatch(embedJson.description, /Bot quản lý/);
  // Dropdown customId carries lang.
  const select = reply.components[0].toJSON().components[0];
  assert.equal(select.custom_id, "raid-help:select:en");
});

test("language=vi (default) renders Vietnamese overview", async () => {
  const factory = makeFactory();
  const interaction = makeReplyInteraction({ language: "vi" });
  await factory.handleRaidHelpCommand(interaction);

  const embedJson = interaction._calls.reply[0].embeds[0].toJSON();
  assert.match(embedJson.title, /\(VI\)/);
  assert.match(embedJson.description, /Bot quản lý/);
  assert.doesNotMatch(embedJson.description, /Lost Ark raid progress tracker/);
});

test("invalid language value falls back to default vi", async () => {
  const factory = makeFactory();
  const interaction = makeReplyInteraction({ language: "fr" });
  await factory.handleRaidHelpCommand(interaction);

  const embedJson = interaction._calls.reply[0].embeds[0].toJSON();
  assert.match(embedJson.title, /\(VI\)/);
});

test("detail embed in English: notes with VN: prefix are stripped", async () => {
  // /raid-add-roster section has paired EN: / VN: notes — under en mode,
  // the VN-prefixed lines must NOT appear.
  const factory = makeFactory();
  const interaction = makeSelectInteraction("raid-add-roster", { lang: "en" });
  await factory.handleRaidHelpSelect(interaction);

  const allFields = getAllFieldValues(interaction._calls.update[0].embeds[0].toJSON());
  // EN line about fetching the full account survives.
  assert.match(allFields, /fetches the full account/i);
  // VN line about "fetch toàn bộ roster" must not appear.
  assert.doesNotMatch(allFields, /toàn bộ roster/);
  // The "VN: " prefix itself shouldn't leak into the rendered text.
  assert.doesNotMatch(allFields, /^VN:/m);
});

test("detail embed in Vietnamese: notes with EN: prefix are stripped", async () => {
  const factory = makeFactory();
  const interaction = makeSelectInteraction("raid-add-roster", { lang: "vi" });
  await factory.handleRaidHelpSelect(interaction);

  const allFields = getAllFieldValues(interaction._calls.update[0].embeds[0].toJSON());
  assert.match(allFields, /toàn bộ roster/);
  assert.doesNotMatch(allFields, /fetches the full account/i);
  assert.doesNotMatch(allFields, /^EN:/m);
});

test("detail embed: untagged technical bullets render in BOTH languages", async () => {
  // Notes lines starting with "•" (no EN:/VN: prefix) are shared
  // technical jargon — they must survive both language filters.
  const factory = makeFactory();

  const enInteraction = makeSelectInteraction("raid-add-roster", { lang: "en" });
  await factory.handleRaidHelpSelect(enInteraction);
  const enFields = getAllFieldValues(enInteraction._calls.update[0].embeds[0].toJSON());

  const viInteraction = makeSelectInteraction("raid-add-roster", { lang: "vi" });
  await factory.handleRaidHelpSelect(viInteraction);
  const viFields = getAllFieldValues(viInteraction._calls.update[0].embeds[0].toJSON());

  // Cap line is a shared technical line (no EN:/VN: prefix) — must
  // appear in both languages. Round-30 rewrite tightened the copy to
  // "Cap 20 char/roster" (singular "char").
  assert.match(enFields, /Cap 20 char\/roster/);
  assert.match(viFields, /Cap 20 char\/roster/);
});

test("detail embed in English uses 'No options' label for option-less sections", async () => {
  const factory = makeFactory();
  const interaction = makeSelectInteraction("raid-status", { lang: "en" });
  await factory.handleRaidHelpSelect(interaction);

  const optionsField = interaction._calls.update[0].embeds[0].toJSON().fields.find((f) => f.name === "Options");
  assert.match(optionsField.value, /No options/i);
});

test("detail embed in Vietnamese uses 'Không có options' label", async () => {
  const factory = makeFactory();
  const interaction = makeSelectInteraction("raid-status", { lang: "vi" });
  await factory.handleRaidHelpSelect(interaction);

  const optionsField = interaction._calls.update[0].embeds[0].toJSON().fields.find((f) => f.name === "Options");
  assert.match(optionsField.value, /Không có options/i);
});

test("handleRaidHelpSelect: valid section key returns matching detail embed", async () => {
  const factory = makeFactory();
  const interaction = makeSelectInteraction("raid-add-roster");
  await factory.handleRaidHelpSelect(interaction);

  assert.equal(interaction._calls.update.length, 1);
  const embedJson = interaction._calls.update[0].embeds[0].toJSON();
  assert.match(embedJson.title, /raid-add-roster/);
  // Options field should mention the `name` arg (required for /raid-add-roster).
  const allFields = getAllFieldValues(embedJson);
  assert.match(allFields, /`name`/);
});

test("handleRaidHelpSelect: invalid section key falls back to overview", async () => {
  const factory = makeFactory();
  const interaction = makeSelectInteraction("nonexistent-key");
  await factory.handleRaidHelpSelect(interaction);

  const embedJson = interaction._calls.update[0].embeds[0].toJSON();
  // Overview title vs detail title — overview matches the bot-name title.
  assert.match(embedJson.title, /Raid Management Bot/i);
});

test("handleRaidHelpSelect: every known section key renders without throwing", async () => {
  // Smoke test — guards against future sections forgetting required
  // fields (key/label/icon/short/shortVn/options/example/notes) which
  // would crash buildHelpDetailEmbed at render time.
  const factory = makeFactory();
  for (const key of EXPECTED_SECTION_KEYS) {
    const interaction = makeSelectInteraction(key);
    await factory.handleRaidHelpSelect(interaction);
    const embedJson = interaction._calls.update[0].embeds[0].toJSON();
    assert.ok(embedJson.title, `section "${key}" must produce a non-empty title`);
    // Every detail embed has at least Options + Example + Notes fields.
    assert.ok(embedJson.fields.length >= 3, `section "${key}" expected ≥3 fields, got ${embedJson.fields.length}`);
  }
});

test("detail embed: every field value stays within Discord's 1024-char limit", async () => {
  // Regression guard against an overlong notes string crashing render.
  // splitHelpFieldValue is supposed to chunk; this asserts that
  // contract holds across every section's actual content.
  const factory = makeFactory();
  for (const key of EXPECTED_SECTION_KEYS) {
    const interaction = makeSelectInteraction(key);
    await factory.handleRaidHelpSelect(interaction);
    const embedJson = interaction._calls.update[0].embeds[0].toJSON();
    for (const field of embedJson.fields) {
      assert.ok(
        field.value.length <= 1024,
        `section "${key}" field "${field.name}" exceeds 1024 chars (${field.value.length})`
      );
    }
  }
});

test("detail embed: required-option marker (✅) renders for required args", async () => {
  // /raid-add-roster's `name` option is required; the detail embed should
  // surface that with a ✅ marker so users see at-a-glance which args
  // are mandatory.
  const factory = makeFactory();
  const interaction = makeSelectInteraction("raid-add-roster");
  await factory.handleRaidHelpSelect(interaction);

  const allFields = getAllFieldValues(interaction._calls.update[0].embeds[0].toJSON());
  assert.match(allFields, /✅ `name`/);
});

test("detail embed: optional-option marker (⚪) renders for optional args", async () => {
  // /raid-add-roster's `target` option is optional → ⚪ marker.
  const factory = makeFactory();
  const interaction = makeSelectInteraction("raid-add-roster");
  await factory.handleRaidHelpSelect(interaction);

  const allFields = getAllFieldValues(interaction._calls.update[0].embeds[0].toJSON());
  assert.match(allFields, /⚪ `target`/);
});

test("detail embed: 'Không có options' surfaces when section has empty options array (default lang)", async () => {
  // /raid-status has no options. Detail embed shouldn't render an
  // empty Options field — must surface the explicit notice instead.
  // Default lang is vi → "Không có options". The English equivalent
  // ("No options") has its own dedicated test below.
  const factory = makeFactory();
  const interaction = makeSelectInteraction("raid-status");
  await factory.handleRaidHelpSelect(interaction);

  const embedJson = interaction._calls.update[0].embeds[0].toJSON();
  const optionsField = embedJson.fields.find((f) => f.name === "Options");
  assert.ok(optionsField, "should still have an Options field even when empty");
  assert.match(optionsField.value, /Không có options/i);
});

test("dropdown options carry section icons as emoji + truncated descriptions ≤100 chars", async () => {
  // Discord StringSelectMenu option description has a 100-char limit.
  // raid-help builds options with `section.short.slice(0, 100)` — verify
  // that and that emoji are passed through.
  const factory = makeFactory();
  const interaction = makeReplyInteraction();
  await factory.handleRaidHelpCommand(interaction);

  const row = interaction._calls.reply[0].components[0].toJSON();
  const options = row.components[0].options;
  for (const opt of options) {
    assert.ok(opt.description.length <= 100, `option "${opt.value}" description over 100 chars`);
    assert.ok(opt.emoji, `option "${opt.value}" should carry an emoji`);
  }
});
