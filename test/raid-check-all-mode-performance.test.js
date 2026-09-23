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
  const backgroundRefresh = source.indexOf("void startBackgroundRefresh(");
  const backgroundTeams = source.indexOf("void teamsView");

  assert.ok(firstReply >= 0, "initial editReply assignment is missing");
  assert.ok(backgroundAuthorMeta > firstReply, "author metadata fetch started before first render");
  assert.ok(backgroundRefresh > firstReply, "roster refresh started before first render");
  assert.ok(backgroundTeams > firstReply, "teams query started before first render");
  assert.doesNotMatch(source, /interaction\.fetchReply\(/);
});

test("raid-check keeps navigation, roster refresh and Sync-check all on one button row", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "bot",
      "handlers",
      "raid-check",
      "all-mode",
      "all-mode-view.js"
    ),
    "utf8"
  );

  assert.match(
    source,
    /const row = hasCurrentPage\s*\? buildPaginationRow/,
    "pagination should remain available while the selector follows the visible roster"
  );
  assert.match(
    source,
    /row\.addComponents\(\s*buildRosterRefreshButton/,
    "roster refresh should share the button row with Prev and Next"
  );
  assert.match(
    source,
    /row\.addComponents\(buildSyncAllButton\(/,
    "Sync-check all should join the same row in every view"
  );
  assert.match(
    source,
    /buildSyncAllButton\(\{[\s\S]*?disabled:\s*disabled\s*\|\|\s*backgroundRefreshing/,
    "Sync-check all should wait until the opening roster refresh finishes"
  );
  assert.match(
    source,
    /currentPageIndex:\s*currentAbsoluteIndex\(\)/,
    "the roster selector should mark the roster rendered on the current page"
  );
  assert.match(
    source,
    /currentPageUserId:\s*\r?\n?\s*pagesData\[currentAbsoluteIndex\(\)\]\?\.userDoc\?\.discordId/,
    "the user selector should mark the user rendered on the current page"
  );
});
