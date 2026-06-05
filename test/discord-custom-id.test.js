const test = require("node:test");
const assert = require("node:assert/strict");

const {
  customIdPart,
  splitCustomId,
} = require("../bot/utils/discord/custom-id");

test("discord custom id helper splits colon-separated custom IDs", () => {
  assert.deepEqual(splitCustomId("raid-check-all:view-toggle:task"), [
    "raid-check-all",
    "view-toggle",
    "task",
  ]);
});

test("discord custom id helper normalizes missing IDs to one empty segment", () => {
  assert.deepEqual(splitCustomId(null), [""]);
  assert.deepEqual(splitCustomId(undefined), [""]);
});

test("discord custom id helper returns indexed parts with fallback", () => {
  assert.equal(customIdPart("raid-help:select:vi", 2), "vi");
  assert.equal(customIdPart("raid-help:select", 2), "");
  assert.equal(customIdPart("raid-help:select", 2, "vi"), "vi");
});
