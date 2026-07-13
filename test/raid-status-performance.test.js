"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("raid-status renders before refresh, local token, schedule, and canvas I/O", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-status", "index.js"),
    "utf8"
  );
  const firstReply = source.indexOf("const messageFromEdit = await interaction.editReply");
  const backgroundRefresh = source.indexOf("void startBackgroundRefresh()");
  const localSyncHydration = source.indexOf("syncControls.hydrateLocalSyncResumeUrl");
  const scheduleHydration = source.indexOf("const myRaidsHydration = findActiveEventsForUser");

  assert.ok(firstReply >= 0, "initial editReply assignment is missing");
  assert.ok(backgroundRefresh > firstReply, "roster refresh started before first render");
  assert.ok(localSyncHydration > firstReply, "local-sync token lookup started before first render");
  assert.ok(scheduleHydration > firstReply, "raid schedule query started before first render");
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
