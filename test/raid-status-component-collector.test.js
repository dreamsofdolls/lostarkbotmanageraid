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
    buildCurrentEmbeds: () => [{}],
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
    buildCurrentEmbeds: () => [{}],
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

// A collector whose card and controls both name the page they were built
// for. Page 1's background is slow (a first Mongo read), page 2's is fast.
function attachPagedCollector({ backgroundMs = [0, 60, 5] } = {}) {
  const listeners = new Map();
  const edits = [];
  const pages = ["Alpha", "Bravo", "Charlie"];
  let page = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  attachRaidStatusComponentCollector({
    EmbedBuilder: { from: (embed) => ({ ...embed, setFooter() { this.expired = true; } }) },
    User: {},
    interaction: {
      user: { id: "owner" },
      editReply: async (payload) => {
        edits.push({
          card: payload.embeds[0].shows,
          controls: payload.components[0].page,
          disabled: payload.components[0].disabled,
        });
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
    getAccounts: () => pages.map((accountName) => ({ accountName })),
    getCurrentPage: () => page,
    getCurrentView: () => "raid",
    buildCurrentEmbeds: () => [{ shows: pages[page] }],
    buildEmbedAndCanvas: async () => {
      const embeds = [{ shows: pages[page] }];
      await sleep(backgroundMs[page]);
      return { embeds };
    },
    buildComponents: (disabled) => [{ page: pages[page], disabled }],
    componentRouteHandlers: {
      next: async () => {
        page += 1;
      },
    },
  });
  const click = () => listeners.get("collect")({
    customId: "status:next",
    user: { id: "owner" },
    deferUpdate: () => sleep(10),
  });
  return { listeners, edits, click, sleep };
}

test("two quick page clicks never leave one page's card with another page's controls", async () => {
  const { edits, click, sleep } = attachPagedCollector();
  const first = click();
  await sleep(12);
  const second = click();
  await Promise.all([first, second]);

  for (const edit of edits) assert.equal(edit.card, edit.controls);
  assert.deepEqual(edits.at(-1), { card: "Charlie", controls: "Charlie", disabled: false });
});

test("a redraw that finishes after the session ended leaves the expired card", async () => {
  const { listeners, edits, click, sleep } = attachPagedCollector({ backgroundMs: [0, 60, 60] });
  const pending = click();
  await sleep(20);
  await listeners.get("end")();
  await pending;

  assert.equal(edits.length, 1);
  assert.equal(edits[0].disabled, true);
});
