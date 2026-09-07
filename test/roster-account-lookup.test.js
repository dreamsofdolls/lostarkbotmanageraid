"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { findAccountByName } = require("../bot/utils/user-doc");
const normalize = (value) => String(value || "").trim().toLowerCase();

test("roster lookup returns the first original account under the caller's normalization", () => {
  const first = { accountName: " Main " };
  const second = { accountName: "MAIN" };
  const doc = { accounts: [null, first, second] };
  assert.strictEqual(findAccountByName(doc, "main", normalize), first);
  assert.strictEqual(findAccountByName(doc, "MAIN", (value) => value), second);
});

test("roster lookup rejects missing and blank names without selecting a nameless account", () => {
  for (const doc of [null, {}, { accounts: {} }, { accounts: [null, {}] }]) {
    assert.equal(findAccountByName(doc, "main", normalize), null);
    assert.equal(findAccountByName(doc, " ", normalize), null);
  }
});
