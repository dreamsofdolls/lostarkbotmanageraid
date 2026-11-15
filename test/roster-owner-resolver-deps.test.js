"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRosterOwnerResolver } = require("../bot/services/raid/roster-owner-resolver");

const fullDeps = () => ({
  User: {},
  normalizeName: (value) => value,
  loadUserForAutocomplete: async () => null,
  getAccessibleAccounts: async () => [],
  isManagerId: () => false,
});

test("the roster owner resolver names each missing dependency at construction", () => {
  assert.doesNotThrow(() => createRosterOwnerResolver(fullDeps()));
  assert.throws(
    () => createRosterOwnerResolver({ ...fullDeps(), User: null }),
    { message: "[roster-owner-resolver] User model required" },
  );
  for (const name of ["normalizeName", "loadUserForAutocomplete", "getAccessibleAccounts", "isManagerId"]) {
    assert.throws(
      () => createRosterOwnerResolver({ ...fullDeps(), [name]: true }),
      { message: `[roster-owner-resolver] ${name} required` },
      name,
    );
  }
});

test("the first missing dependency in order is the one named", () => {
  assert.throws(
    () => createRosterOwnerResolver({ ...fullDeps(), loadUserForAutocomplete: null, isManagerId: null }),
    { message: "[roster-owner-resolver] loadUserForAutocomplete required" },
  );
});
