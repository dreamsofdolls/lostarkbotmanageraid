"use strict";

// A /raid-status session can outlive its last roster: the user removes it
// with /raid-remove-roster, or the only share is revoked, while the card is
// open. The next reload leaves no accounts, and the card must fall back to
// the no-roster notice the command shows on open instead of throwing on
// every click.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRaidStatusRenderPayload } = require("../bot/handlers/raid-status/view/render-payload");
const { createRaidStatusComponentLayout } = require("../bot/handlers/raid-status/components/component-layout");

const NO_ROSTER = { title: "No roster yet" };

function emptyRenderPayload(view = "raid") {
  return createRaidStatusRenderPayload({
    discordId: "u1",
    getAccounts: () => [],
    getCurrentPage: () => 0,
    getCurrentView: () => view,
    getFilterRaidId: () => null,
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: () => [],
    getTotalCharacters: () => 0,
    summarizeRaidProgress: () => ({}),
    summarizeGlobalGold: () => ({}),
    buildAccountPageEmbed: (account) => ({ characters: account.characters }),
    buildGoldViewEmbed: (account) => ({ characters: account.characters }),
    buildTaskViewEmbed: (account) => ({ characters: account.characters }),
    buildEmptyRosterEmbed: () => NO_ROSTER,
    lang: "en",
  });
}

test("a session left without rosters shows the no-roster notice in every view", async () => {
  for (const view of ["raid", "gold", "task"]) {
    const renderPayload = emptyRenderPayload(view);
    assert.deepEqual(renderPayload.buildCurrentEmbeds(), [NO_ROSTER], view);
    const payload = await renderPayload.buildEmbedAndCanvas();
    assert.deepEqual(payload.embeds, [NO_ROSTER], view);
    assert.deepEqual(payload.files, [], view);
  }
});

test("a session left without rosters has no controls, as when opened without one", () => {
  const { buildComponents } = createRaidStatusComponentLayout({
    lang: "en",
    getAccounts: () => [],
    getCurrentPage: () => 0,
    getCurrentView: () => "raid",
    getStatusUserMeta: () => ({}),
  });
  assert.deepEqual(buildComponents(false), []);
  assert.deepEqual(buildComponents(true), []);
});
