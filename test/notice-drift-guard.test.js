/**
 * test/notice-drift-guard.test.js
 * Keeps every simple notice on the one notice family: no legacy severity
 * option, no hand-built embed outside the rich cards, no unknown kind.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { NoticeKind } = require("../bot/utils/raid/common/shared");

const ROOT = path.join(__dirname, "..");

function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "locales") listSourceFiles(full, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = listSourceFiles(path.join(ROOT, "bot")).map((file) => ({
  file: path.relative(ROOT, file).replaceAll("\\", "/"),
  lines: fs.readFileSync(file, "utf8").split(/\r?\n/),
}));

function findLines(pattern) {
  return SOURCES.flatMap(({ file, lines }) =>
    lines.flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : [])));
}

// The rich cards of the inventory (section 5a), the closed roster-picker card
// and the notice helper itself. A simple notice anywhere else goes through
// buildNoticeEmbed.
const RICH_CARD_FILES = new Set([
  "bot/handlers/local-sync/discord-console-ui.js",
  "bot/handlers/meta/help.js",
  "bot/handlers/meta/language.js",
  "bot/handlers/raid/announce/show.js",
  "bot/handlers/raid/auction.js",
  "bot/handlers/raid/auto-manage/basic-actions.js",
  "bot/handlers/raid/bg/library.js",
  "bot/handlers/raid/bg/scene-browser.js",
  "bot/handlers/raid/channel/core-actions.js",
  "bot/handlers/raid/log-picker.js",
  "bot/handlers/raid/log-recent-view.js",
  "bot/handlers/raid/log-view.js",
  "bot/handlers/raid/share.js",
  "bot/handlers/raid-check/auto-manage/auto-manage-dm.js",
  "bot/handlers/raid-status/gold/gold-ui/embed.js",
  "bot/handlers/raid-status/task/task-ui/embed.js",
  "bot/handlers/raid-status/view/view.js",
  "bot/handlers/roster/add/view.js",
  "bot/handlers/roster/edit/edit-render.js",
  "bot/handlers/roster/gold-earner/render.js",
  "bot/handlers/roster/picker/render.js",
  "bot/services/auto-manage/reports/embeds.js",
  "bot/services/raid/channel-monitor/channel-monitor-embeds.js",
  "bot/utils/raid/common/shared.js",
]);

test("no legacy severity option reaches a notice", () => {
  assert.deepEqual(findLines(/\btype:\s*["'](info|warn|lock|muted|success|error)["']/), []);
});

test("hand-built embeds stay in the rich-card files", () => {
  const outside = findLines(/new EmbedBuilder\(\)/)
    .filter((site) => !RICH_CARD_FILES.has(site.replace(/:\d+$/, "")));
  assert.deepEqual(outside, []);
});

test("every NoticeKind named in bot/ exists", () => {
  const unknown = SOURCES.flatMap(({ file, lines }) => lines.flatMap((line, index) =>
    [...line.matchAll(/\bNoticeKind\.([A-Za-z_]+)/g)]
      .filter(([, name]) => !(name in NoticeKind))
      .map(([match]) => `${file}:${index + 1} ${match}`)));
  assert.deepEqual(unknown, []);
});
