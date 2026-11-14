"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { escapeEmbedText } = require("../bot/utils/discord/embed-text");
const { buildShareRefusalNotice } = require("../bot/handlers/raid/task/notices");
const { buildAccountTaskFields } = require("../bot/utils/raid/tasks/task-view");

const MASKED_LINK = "[Claim](https://x.example)";
const ESCAPED_LINK = "\\[Claim\\](https://x.example)";

test("escapeEmbedText escapes markdown and the brackets of a masked link", () => {
  assert.equal(escapeEmbedText(MASKED_LINK), ESCAPED_LINK);
  assert.equal(escapeEmbedText("**a**"), "\\*\\*a\\*\\*");
  assert.equal(escapeEmbedText("Mira"), "Mira");
  assert.equal(escapeEmbedText(undefined), "");
});

test("share refusal notice shows the owner's name as text, not a link", () => {
  const notice = buildShareRefusalNotice("viewOnly", { ownerLabel: MASKED_LINK }, "en");
  assert.ok(notice.description.includes(ESCAPED_LINK), notice.description);
});

test("task view shows a task name as text, not a link", () => {
  const account = {
    characters: [{ name: "Aki", class: "Bard", itemLevel: 1700, sideTasks: [{ taskId: "1", name: MASKED_LINK, reset: "daily" }] }],
  };
  const { fields } = buildAccountTaskFields(account, { UI: { icons: { done: "D", pending: "P" } }, truncateText: (s) => s });
  const values = fields.map((field) => field.value).join("\n");
  assert.ok(values.includes(`P ${ESCAPED_LINK}`), values);
});
