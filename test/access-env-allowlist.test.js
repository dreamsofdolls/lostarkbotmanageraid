"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseEnvAllowlistIds,
  createEnvAllowlistChecker,
} = require("../bot/services/access/env-allowlist");
const { parseManagerIds } = require("../bot/services/access/manager");

test("parseEnvAllowlistIds supports comma, whitespace, empties, dedupe, and quotes", () => {
  const ids = parseEnvAllowlistIds(" 111,222  333,, '444' \"555\" 111 ");

  assert.deepEqual([...ids], ["111", "222", "333", "444", "555"]);
});

test("parseEnvAllowlistIds can read a named env var when no raw value is supplied", () => {
  const previous = process.env.TEST_ACCESS_ALLOWLIST;
  process.env.TEST_ACCESS_ALLOWLIST = '"abc,def" ghi';
  try {
    const ids = parseEnvAllowlistIds(undefined, {
      envName: "TEST_ACCESS_ALLOWLIST",
    });
    assert.deepEqual([...ids], ["abc", "def", "ghi"]);
  } finally {
    if (previous == null) delete process.env.TEST_ACCESS_ALLOWLIST;
    else process.env.TEST_ACCESS_ALLOWLIST = previous;
  }
});

test("createEnvAllowlistChecker fails closed and stringifies ids", () => {
  const isAllowlisted = createEnvAllowlistChecker(new Set(["123", "456"]));

  assert.equal(isAllowlisted("123"), true);
  assert.equal(isAllowlisted(456), true);
  assert.equal(isAllowlisted("999"), false);
  assert.equal(isAllowlisted(""), false);
  assert.equal(isAllowlisted(undefined), false);
});

test("manager parser shares the env allowlist rules", () => {
  assert.deepEqual([...parseManagerIds(" 123, '456' 789 ")], ["123", "456", "789"]);
});
