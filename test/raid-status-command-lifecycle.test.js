"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRaidStatusCommand } = require("../bot/handlers/raid-status");
const User = require("../bot/models/user");
const {
  createCollectorMessage,
  createStatusCommandDeps,
  mockStatusSideReads,
} = require("./helpers/raid-status-command-fixture");

test("late command background refresh keeps the newer roster and sync metadata loaded by a click", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let databaseDoc = { discordId: "lifecycle-viewer", language: "en", localSyncEnabled: false,
    accounts: [{ accountName: "Roster", characters: [{ name: "Before", itemLevel: 1740 }] }] };
  t.mock.method(User, "findOne", () => {
    const snapshot = structuredClone(databaseDoc);
    return { select() { return this; }, lean: async () => snapshot,
      then: (resolve, reject) => Promise.resolve(snapshot).then(resolve, reject) };
  });
  mockStatusSideReads(t);
  const listeners = new Map(), edits = [];
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const message = createCollectorMessage(listeners);
  const interaction = { user: { id: "lifecycle-viewer" }, guildId: "guild",
    deferReply: async () => {}, editReply: async payload => { edits.push(payload); return message; } };
  const command = createRaidStatusCommand(createStatusCommandDeps({
    collectStaleAccountRefreshes: async () => { enter(); return held; },
    getStatusRaidsForCharacter: () => [],
  }));
  try {
    await command.handleStatusCommand(interaction);
    await entered;
    await new Promise(resolve => setImmediate(resolve));
    databaseDoc.localSyncEnabled = true;
    databaseDoc.accounts[0].characters[0].name = "After";
    t.mock.timers.tick(5000);
    await listeners.get("collect")({ user: interaction.user, customId: "status-view:toggle", values: ["raid"], deferUpdate: async () => {} });
    const text = payload => JSON.stringify(payload.embeds.map(embed => embed.toJSON()));
    assert.match(text(edits.at(-1)), /After/);
    finish([]);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(text(edits.at(-1)), /After/);
    assert.doesNotMatch(text(edits.at(-1)), /Before/);
    assert.match(text(edits.at(-1)), /Local[- ]sync/i);
  } finally {
    finish([]);
    await new Promise(resolve => setImmediate(resolve));
    await listeners.get("end")?.();
  }
});
