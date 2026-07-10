"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createStuckNudgeButtonHandler,
} = require("../bot/handlers/local-sync/stuck-nudge-button");
const { UI } = require("../bot/utils/raid/common/shared");

class FakeEmbedBuilder {
  constructor() {
    this.data = {};
  }

  setColor(value) { this.data.color = value; return this; }
  setTitle(value) { this.data.title = value; return this; }
  setDescription(value) { this.data.description = value; return this; }
  setTimestamp() { this.data.timestamp = true; return this; }
}

class FakeActionRowBuilder {
  addComponents(...components) {
    this.components = components;
    return this;
  }
}

class FakeButtonBuilder {
  setStyle(value) { this.style = value; return this; }
  setLabel(value) { this.label = value; return this; }
  setURL(value) { this.url = value; return this; }
}

function makeHandler(overrides = {}) {
  return createStuckNudgeButtonHandler({
    EmbedBuilder: FakeEmbedBuilder,
    ActionRowBuilder: FakeActionRowBuilder,
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle: { Link: 5 },
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: {},
    ...overrides,
  }).handleStuckNudgeButton;
}

test("stuck-nudge owner click defers update before language, state, and token work", async (t) => {
  const previousBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "https://sync.example.test";
  t.after(() => {
    if (previousBaseUrl == null) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  });

  const events = [];
  let editPayload = null;
  let dmPayload = null;
  const handle = makeHandler({
    getUserLanguageFn: async () => { events.push("language"); return "en"; },
    setLocalSyncEnabledFn: async () => {
      events.push("setLocalSyncEnabled");
      return { ok: true, reason: "ok" };
    },
    rotateLocalSyncTokenFn: async () => {
      events.push("rotateLocalSyncToken");
      return "signed-token";
    },
  });
  const interaction = {
    customId: "stuck-nudge:switch-to-local:123456789",
    user: {
      id: "123456789",
      globalName: "Traine",
      displayAvatarURL: () => "https://cdn.example.test/avatar.webp",
    },
    deferUpdate: async () => { events.push("deferUpdate"); },
    editReply: async (payload) => {
      events.push("editReply");
      editPayload = payload;
    },
    followUp: async () => { throw new Error("followUp should not be used on success"); },
    client: {
      users: {
        fetch: async () => ({
          send: async (payload) => { dmPayload = payload; },
        }),
      },
    },
  };

  await handle(interaction);

  assert.deepEqual(events.slice(0, 4), [
    "deferUpdate",
    "language",
    "setLocalSyncEnabled",
    "rotateLocalSyncToken",
  ]);
  assert.ok(editPayload, "the original nudge should be edited after the deferred update");
  assert.deepEqual(editPayload.components, []);
  assert.ok(dmPayload, "the private companion link should still be delivered by DM");
});

test("stuck-nudge foreign click defers an ephemeral reply before language lookup", async () => {
  const events = [];
  let deferPayload = null;
  let editPayload = null;
  const handle = makeHandler({
    getUserLanguageFn: async () => { events.push("language"); return "en"; },
    setLocalSyncEnabledFn: async () => {
      throw new Error("state must not change for a foreign clicker");
    },
  });
  const interaction = {
    customId: "stuck-nudge:switch-to-local:123456789",
    user: { id: "987654321" },
    deferReply: async (payload) => {
      events.push("deferReply");
      deferPayload = payload;
    },
    editReply: async (payload) => {
      events.push("editReply");
      editPayload = payload;
    },
  };

  await handle(interaction);

  assert.equal(events[0], "deferReply");
  assert.equal(deferPayload.flags, 64);
  assert.ok(editPayload, "the ownership notice should edit the deferred reply");
});

test("stuck-nudge state failure follows up ephemerally after deferUpdate", async () => {
  const events = [];
  let followUpPayload = null;
  const handle = makeHandler({
    getUserLanguageFn: async () => "en",
    setLocalSyncEnabledFn: async () => {
      events.push("setLocalSyncEnabled");
      throw new Error("mongo unavailable");
    },
  });
  const interaction = {
    customId: "stuck-nudge:switch-to-local:123456789",
    user: { id: "123456789" },
    deferUpdate: async () => { events.push("deferUpdate"); },
    followUp: async (payload) => {
      events.push("followUp");
      followUpPayload = payload;
    },
  };

  await handle(interaction);

  assert.deepEqual(events, ["deferUpdate", "setLocalSyncEnabled", "followUp"]);
  assert.equal(followUpPayload.flags, 64);
});
