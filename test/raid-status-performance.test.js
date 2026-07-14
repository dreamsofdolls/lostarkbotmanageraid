"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createRaidStatusRenderPayload,
} = require("../bot/handlers/raid-status/view/render-payload");

test("raid-status renders before refresh, local token, schedule, and canvas I/O", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-status", "index.js"),
    "utf8"
  );
  const firstReply = source.indexOf("const messageFromEdit = await interaction.editReply");
  const backgroundRefresh = source.indexOf("void startBackgroundRefresh()");
  const localSyncHydration = source.indexOf("syncControls.hydrateLocalSyncResumeUrl");
  const scheduleHydration = source.indexOf("const myRaidsHydration = findActiveEventsForUser");
  const activityStamp = source.indexOf("void markRaidStatusOpenedDay");

  assert.ok(firstReply >= 0, "initial editReply assignment is missing");
  assert.ok(backgroundRefresh > firstReply, "roster refresh started before first render");
  assert.ok(localSyncHydration > firstReply, "local-sync token lookup started before first render");
  assert.ok(scheduleHydration > firstReply, "raid schedule query started before first render");
  assert.ok(activityStamp > firstReply, "daily activity stamp ran before first render");
  assert.match(source, /embeds: \[buildCurrentEmbed\(\)\]/);
  assert.doesNotMatch(
    source,
    /const message = await interaction\.fetchReply\(\)/,
    "production should reuse the Message returned by editReply"
  );
});

test("raid-status viewer seed, language, and shares load concurrently", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "bot",
      "handlers",
      "raid-status",
      "state",
      "viewer-state.js"
    ),
    "utf8"
  );

  assert.match(source, /await Promise\.all\(\[/);
});

test("raid-status reuses global roster totals while paginating the same snapshot", () => {
  const accounts = [
    { accountName: "A", characters: [{ raids: [{ raidKey: "act4", modeKey: "hard" }] }] },
    { accountName: "B", characters: [{ raids: [{ raidKey: "kazeros", modeKey: "hard" }] }] },
  ];
  let currentPage = 0;
  let progressCalls = 0;
  let goldCalls = 0;
  let pageRenders = 0;
  const { buildCurrentEmbed } = createRaidStatusRenderPayload({
    discordId: "viewer",
    getAccounts: () => accounts,
    getCurrentPage: () => currentPage,
    getCurrentView: () => "raid",
    getFilterRaidId: () => null,
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: (character) => character.raids,
    totalCharacters: 2,
    summarizeRaidProgress: (raids) => {
      progressCalls += 1;
      return { completed: 0, partial: 0, total: raids.length };
    },
    summarizeGlobalGold: () => {
      goldCalls += 1;
      return { earned: 0, total: 0 };
    },
    buildAccountPageEmbed: () => {
      pageRenders += 1;
      return {};
    },
    buildGoldViewEmbed: () => ({}),
    buildTaskViewEmbed: () => ({}),
    lang: "en",
  });

  buildCurrentEmbed();
  currentPage = 1;
  buildCurrentEmbed();

  assert.equal(pageRenders, 2);
  assert.equal(progressCalls, 1);
  assert.equal(goldCalls, 1);
});
