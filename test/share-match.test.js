"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { findSharedRosterEntry } = require("../bot/utils/share-match");

const normalizeName = (name) => String(name || "").trim().toLowerCase();
const entry = (ownerDiscordId, accessLevel, extra = {}) => ({
  ownerDiscordId,
  accountName: "Shared",
  accessLevel,
  isOwn: false,
  ...extra,
});

test("findSharedRosterEntry prefers an edit share over an earlier view share", () => {
  const entries = [entry("viewer-owner", "view"), entry("editor-owner", "edit")];
  assert.equal(findSharedRosterEntry(entries, "Shared", normalizeName), entries[1]);
});

test("findSharedRosterEntry returns the first match when no share allows edit", () => {
  const entries = [entry("owner-a", "view"), entry("owner-b", "view")];
  assert.equal(findSharedRosterEntry(entries, "Shared", normalizeName), entries[0]);
});

test("findSharedRosterEntry ignores own entries and other roster names", () => {
  const entries = [
    entry("me", "edit", { isOwn: true }),
    entry("owner-a", "edit", { accountName: "Other" }),
    entry("owner-b", "view"),
  ];
  assert.equal(findSharedRosterEntry(entries, " shared ", normalizeName), entries[2]);
});

test("findSharedRosterEntry returns null when nothing matches", () => {
  assert.equal(findSharedRosterEntry([], "Shared", normalizeName), null);
  assert.equal(
    findSharedRosterEntry([entry("me", "edit", { isOwn: true })], "Shared", normalizeName),
    null
  );
});
