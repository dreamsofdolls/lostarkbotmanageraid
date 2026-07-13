"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("raid-check renders before starting roster and teams background work", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "bot",
      "handlers",
      "raid-check",
      "all-mode",
      "all-mode.js"
    ),
    "utf8"
  );
  const firstReply = source.indexOf("const followup = await interaction.editReply");
  const backgroundAuthorMeta = source.indexOf("void refreshIncompleteAuthorMeta()");
  const backgroundRefresh = source.indexOf("void startBackgroundRefresh()");
  const backgroundTeams = source.indexOf("void teamsView");

  assert.ok(firstReply >= 0, "initial editReply assignment is missing");
  assert.ok(backgroundAuthorMeta > firstReply, "author metadata fetch started before first render");
  assert.ok(backgroundRefresh > firstReply, "roster refresh started before first render");
  assert.ok(backgroundTeams > firstReply, "teams query started before first render");
  assert.doesNotMatch(source, /interaction\.fetchReply\(/);
});

test("raid-check keeps pagination while the selected user is on All rosters", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "bot",
      "handlers",
      "raid-check",
      "all-mode",
      "all-mode.js"
    ),
    "utf8"
  );

  assert.match(
    source,
    /const usesRosterNavigation = Number\.isInteger\(filterRosterIndex\);/,
    "pagination should only be replaced after a specific roster is selected"
  );
});
