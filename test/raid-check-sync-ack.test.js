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
  setDescription(value) { this.description = value; return this; }
  setTimestamp() { return this; }
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

test("raid-check sync commits through the shared retry-safe service", async () => {
  clearUserLanguageCache();
  const commitCalls = [];
  const targetDoc = {
    autoManageEnabled: true,
    accounts: [{ accountName: "Roster", characters: [{ name: "Aki" }] }],
  };
  const User = {
    findOne({ discordId }) {
      if (discordId === "manager") {
        return {
          select() {
            return { lean: async () => ({ language: "vi" }) };
          },
        };
      }
      return Promise.resolve(targetDoc);
    },
  };
  let releaseCount = 0;
  let editPayload = null;
  const ui = createSyncUi({
    EmbedBuilder: FakeEmbedBuilder,
    MessageFlags: { Ephemeral: 64 },
    UI: {
      colors: { success: 1, neutral: 0 },
      icons: { done: "ok", info: "i" },
    },
    User,
    ensureFreshWeek: () => false,
    weekResetStartMs: () => 1234,
    autoManageEntryKey: (accountName, charName) => `${accountName}:${charName}`,
    gatherAutoManageLogsForUserDoc: async (_doc, _reset, options) => {
      assert.deepEqual([...options.includeEntryKeys], ["Roster:Aki"]);
      return { logs: true };
    },
    commitAutoManageCollected: async (...args) => {
      commitCalls.push(args);
      return {
        status: "synced-no-delta",
        report: { perChar: [{ error: null, applied: [] }] },
        snapshot: {},
      };
    },
    stampAutoManageAttempt: async () => {
      throw new Error("fallback stamp must not run");
    },
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {
      releaseCount += 1;
    },
    raidCheckSyncLimiter: { run: (operation) => operation() },
    discordUserLimiter: { run: (operation) => operation() },
    resolveDiscordDisplay: async () => "",
    computeRaidCheckSnapshot: async () => ({
      pendingChars: [{
        discordId: "target",
        accountName: "Roster",
        charName: "Aki",
      }],
      userMeta: new Map([["target", { autoManageEnabled: true }]]),
    }),
  });

  await ui.handleRaidCheckSyncClick({
    user: { id: "manager" },
    client: { users: {} },
    deferReply: async () => {},
    editReply: async (payload) => {
      editPayload = payload;
    },
  }, {
    raidKey: "act4",
    modeKey: "normal",
  });

  assert.equal(commitCalls.length, 1);
  assert.deepEqual(commitCalls[0], [
    "target",
    1234,
    { logs: true },
    { requireRoster: true },
  ]);
  assert.equal(releaseCount, 1);
  assert.match(editPayload.embeds[0].description, /1/);
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
