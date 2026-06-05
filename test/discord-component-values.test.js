const test = require("node:test");
const assert = require("node:assert/strict");

const {
  firstSelectValue,
} = require("../bot/utils/discord/component-values");

test("discord component firstSelectValue returns the first selected value", () => {
  assert.equal(firstSelectValue({ values: ["a", "b"] }, "fallback"), "a");
});

test("discord component firstSelectValue falls back for empty or missing values", () => {
  assert.equal(firstSelectValue({ values: [] }, "fallback"), "fallback");
  assert.equal(firstSelectValue({}, "fallback"), "fallback");
  assert.equal(firstSelectValue(null, "fallback"), "fallback");
});

test("discord component firstSelectValue defaults fallback to null", () => {
  assert.equal(firstSelectValue({ values: [] }), null);
});
