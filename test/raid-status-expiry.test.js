"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { attachRaidStatusComponentCollector } = require("../bot/handlers/raid-status/components/component-collector");

test("session expiry remains the final Discord edit even when an earlier page update is still in flight", async () => {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const listeners = new Map(), edits = [];
  let active = 0, peak = 0;
  attachRaidStatusComponentCollector({
    EmbedBuilder: { from: embed => ({ ...embed, setFooter(footer) { this.footer = footer; return this; } }) },
    User: {}, lang: "en", sessionMs: 60_000, taskAutoRefreshGraceMs: 1000,
    interaction: { user: { id: "owner" }, editReply: async payload => {
      peak = Math.max(peak, ++active);
      if (!payload.components[0].disabled) { enter(); await held; }
      edits.push(payload);
      active--;
    } },
    message: { createMessageComponentCollector: () => ({ on(event, handler) { listeners.set(event, handler); return this; } }) },
    getAccounts: () => [], getCurrentPage: () => 0, getCurrentView: () => "raid",
    buildCurrentEmbeds: () => [{ card: "current" }],
    buildEmbedAndCanvas: async () => ({ embeds: [{ card: "current" }] }),
    buildComponents: disabled => [{ disabled }],
    componentRouteHandlers: { next: async () => ({ redraw: true }) }, refreshStateIfStale: async () => {},
  });
  const updating = listeners.get("collect")({
    user: { id: "owner" }, customId: "status:next", deferUpdate: async () => {},
  });
  await entered;
  const expiring = listeners.get("end")();
  await new Promise(resolve => setImmediate(resolve));
  finish();
  await Promise.all([updating, expiring]);
  assert.equal(edits.at(-1).components[0].disabled, true);
  assert.ok(edits.at(-1).embeds[0].footer);
  assert.deepEqual(edits.at(-1).attachments, []);
  assert.equal(peak, 1);
});
