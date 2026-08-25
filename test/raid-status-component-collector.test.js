"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

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
