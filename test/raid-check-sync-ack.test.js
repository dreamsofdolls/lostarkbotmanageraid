"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createSyncUi,
} = require("../bot/handlers/raid-check/views/sync-ui");
const {
  clearUserLanguageCache,
} = require("../bot/services/i18n");

class FakeEmbedBuilder {
  setColor() { return this; }
  setTitle() { return this; }
  setDescription() { return this; }
}

test("raid-check sync acknowledges before language and snapshot DB work", async () => {
  clearUserLanguageCache();
  const events = [];
  const User = {
    findOne() {
      return {
        lean: async () => {
          events.push("language");
          return { language: "vi" };
        },
      };
    },
  };
  const ui = createSyncUi({
    EmbedBuilder: FakeEmbedBuilder,
    MessageFlags: { Ephemeral: 64 },
    UI: { colors: { neutral: 0 }, icons: { info: "i" } },
    User,
    computeRaidCheckSnapshot: async () => {
      events.push("snapshot");
      return { pendingChars: [], userMeta: new Map() };
    },
  });
  const interaction = {
    user: { id: "sync-manager" },
    deferReply: async () => {
      events.push("defer");
    },
    editReply: async () => {
      events.push("edit");
    },
  };

  await ui.handleRaidCheckSyncClick(interaction, {
    raidKey: "act4",
    modeKey: "normal",
  });

  assert.equal(events[0], "defer");
  assert.ok(events.includes("language"));
  assert.ok(events.includes("snapshot"));
});

test("raid-check edit acknowledges before language lookup", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-check", "edit", "edit-ui.js"),
    "utf8"
  );
  const start = source.indexOf("async function handleRaidCheckEditClick");
  const end = source.indexOf("const scopeAll", start);
  const opening = source.slice(start, end);
  const ackIndex = opening.indexOf("deferEphemeralReply(interaction)");
  const languageIndex = opening.indexOf("getUserLanguage");

  assert.notEqual(ackIndex, -1);
  assert.notEqual(languageIndex, -1);
  assert.ok(ackIndex < languageIndex);
});
