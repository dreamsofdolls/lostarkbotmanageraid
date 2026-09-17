"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder } = require("discord.js");

const {
  attachRaidStatusComponentCollector,
} = require("../bot/handlers/raid-status/components/component-collector");

test("raid-status navigation refreshes an aged snapshot before applying the route", async () => {
  const listeners = new Map();
  const calls = [];
  const collector = {
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
  };
  const interaction = {
    user: { id: "owner" },
    editReply: async () => {
      calls.push("edit");
      return {};
    },
  };

  attachRaidStatusComponentCollector({
    EmbedBuilder: { from: (embed) => embed },
    User: {},
    interaction,
    message: { createMessageComponentCollector: () => collector },
    lang: "en",
    sessionMs: 60_000,
    taskAutoRefreshGraceMs: 1_000,
    getAccounts: () => [],
    getCurrentPage: () => 0,
    getCurrentView: () => "raid",
    buildCurrentEmbed: () => ({}),
    buildEmbedAndCanvas: async () => {
      calls.push("render");
      return { embeds: [{}] };
    },
    buildComponents: () => [],
    componentRouteHandlers: {
      next: async () => {
        calls.push("handler");
      },
    },
    refreshStateIfStale: async () => {
      calls.push("refresh");
    },
  });

  await listeners.get("collect")({
    customId: "status:next",
    user: { id: "owner" },
    deferUpdate: async () => {
      calls.push("defer");
    },
  });

  assert.deepEqual(calls, ["defer", "refresh", "handler", "render", "edit"]);
});

test("a throwing raid-status handler is reported to the clicker instead of rejecting the listener", async () => {
  const listeners = new Map();
  const followUps = [];
  const edits = [];
  attachRaidStatusComponentCollector({
    EmbedBuilder,
    User: {},
    interaction: {
      user: { id: "owner" },
      editReply: async (payload) => {
        edits.push(payload);
        return {};
      },
    },
    message: {
      createMessageComponentCollector: () => ({
        on(event, handler) {
          listeners.set(event, handler);
          return this;
        },
      }),
    },
    lang: "en",
    sessionMs: 60_000,
    taskAutoRefreshGraceMs: 1_000,
    getAccounts: () => [],
    getCurrentPage: () => 0,
    getCurrentView: () => "raid",
    buildCurrentEmbed: () => ({}),
    buildEmbedAndCanvas: async () => ({ embeds: [{}] }),
    buildComponents: () => [],
    componentRouteHandlers: {
      next: async () => {
        throw new Error("mongo unavailable");
      },
    },
  });

  await listeners.get("collect")({
    customId: "status:next",
    user: { id: "owner" },
    deferred: false,
    async deferUpdate() {
      this.deferred = true;
    },
    async followUp(payload) {
      followUps.push(payload);
    },
  });

  assert.equal(followUps.length, 1);
  // A failing button gets its own notice, not the Refresh progress one.
  assert.match(followUps[0].embeds[0].toJSON().title, /This button did not run/);
  assert.match(followUps[0].embeds[0].toJSON().description, /The card was left as it was/);
  assert.deepEqual(edits, []);
});
