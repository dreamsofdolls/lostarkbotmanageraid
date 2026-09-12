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

test("sync all scans every opted-in roster once and keeps local-sync users out", async () => {
  clearUserLanguageCache();
  const events = [];
  const docs = [
    { discordId: "all-target", autoManageEnabled: true, accounts: [
      { accountName: "Roster A", characters: [{ name: "Aki" }, { charName: "Mika" }] },
      { accountName: "Roster B", characters: [{ name: "Sora" }] },
    ] },
    { discordId: "local-target", autoManageEnabled: true, localSyncEnabled: true, accounts: [
      { accountName: "Local", characters: [{ name: "Localchar" }] },
    ] },
    { discordId: "opted-out", autoManageEnabled: false, accounts: [
      { accountName: "Off", characters: [{ name: "Offchar" }] },
    ] },
  ];
  const User = {
    find() {
      events.push("query");
      return { select() { return this; }, lean: async () => docs };
    },
    findOne({ discordId }) {
      if (discordId === "all-manager") return { lean: async () => ({ language: "en" }) };
      return Promise.resolve(docs.find(doc => doc.discordId === discordId));
    },
  };
  const ui = createSyncUi({
    EmbedBuilder: FakeEmbedBuilder, MessageFlags: { Ephemeral: 64 },
    UI: { colors: { success: 1 }, icons: { done: "ok" } }, User,
    ensureFreshWeek: () => events.push("week"),
    weekResetStartMs: () => 1234,
    autoManageEntryKey: (accountName, charName) => `${accountName}:${charName}`,
    gatherAutoManageLogsForUserDoc: async (_doc, _reset, options) => {
      events.push("gather");
      assert.deepEqual([...options.includeEntryKeys], ["Roster A:Aki", "Roster A:Mika", "Roster B:Sora"]);
      return { logs: true };
    },
    commitAutoManageCollected: async discordId => {
      assert.equal(discordId, "all-target");
      events.push("commit");
      return { status: "synced-no-delta", report: { perChar: [] } };
    },
    acquireAutoManageSyncSlot: async discordId => {
      assert.equal(discordId, "all-target");
      events.push("acquire");
      return { acquired: true };
    },
    releaseAutoManageSyncSlot: () => events.push("release"),
    raidCheckSyncLimiter: { run: fn => fn() }, discordUserLimiter: { run: fn => fn() },
    computeRaidCheckSnapshot: () => assert.fail("All raids must not reuse a single-raid filter"),
  });
  let reply;
  await ui.handleRaidCheckSyncClick({
    user: { id: "all-manager" }, client: { users: {} },
    deferReply: async () => events.push("defer"),
    editReply: async payload => { reply = payload; },
  }, null);
  assert.deepEqual(events, ["defer", "query", "acquire", "week", "gather", "commit", "release"]);
  assert.match(reply.embeds[0].description, /all raids/i);
});

test("sync all isolates per-user failures, rechecks consent, and releases only acquired slots", async () => {
  clearUserLanguageCache();
  const ids = ["lock-error", "busy", "gather-error", "changed-to-local", "ok-user"];
  const released = [];
  const gathered = [];
  const committed = [];
  const docs = ids.map(discordId => ({
    discordId, autoManageEnabled: true,
    accounts: [{ accountName: "Roster", characters: [{ name: "Aki" }] }],
  }));
  const ui = createSyncUi({
    EmbedBuilder: FakeEmbedBuilder, MessageFlags: { Ephemeral: 64 },
    UI: { colors: { success: 1 }, icons: { done: "ok" } },
    User: {
      find: () => ({ select() { return this; }, lean: async () => docs }),
      findOne: ({ discordId }) => discordId === "failure-manager"
        ? { lean: async () => ({ language: "en" }) }
        : Promise.resolve({ ...docs.find(doc => doc.discordId === discordId), localSyncEnabled: discordId === "changed-to-local" }),
    },
    ensureFreshWeek: () => {}, weekResetStartMs: () => 1234,
    autoManageEntryKey: (account, char) => `${account}:${char}`,
    acquireAutoManageSyncSlot: async discordId => {
      if (discordId === "lock-error") throw new Error("Lock unavailable");
      return { acquired: discordId !== "busy" };
    },
    releaseAutoManageSyncSlot: discordId => released.push(discordId),
    gatherAutoManageLogsForUserDoc: async doc => {
      gathered.push(doc.discordId);
      if (doc.discordId === "gather-error") throw new Error("Gather failed");
      return [];
    },
    commitAutoManageCollected: async discordId => {
      committed.push(discordId);
      return { status: "synced-no-delta", report: { perChar: [] } };
    },
    raidCheckSyncLimiter: { run: fn => fn() }, discordUserLimiter: { run: fn => fn() },
  });
  await ui.handleRaidCheckSyncClick({
    user: { id: "failure-manager" }, client: { users: {} },
    deferReply: async () => {}, editReply: async () => {},
  }, null);
  assert.deepEqual(gathered.sort(), ["gather-error", "ok-user"]);
  assert.deepEqual(committed, ["ok-user"]);
  assert.deepEqual(released.sort(), ["changed-to-local", "gather-error", "ok-user"]);
});
