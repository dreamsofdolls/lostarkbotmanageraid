"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ROSTER_PICKER_ACTION,
  getRosterPickerRoute,
  parseRosterPickerCustomId,
} = require("../bot/handlers/roster/picker-routes");

test("roster picker parser keeps prefix, action, session id, and index slots", () => {
  assert.deepEqual(parseRosterPickerCustomId("gold-earner:toggle:sess1:6"), {
    prefix: "gold-earner",
    action: "toggle",
    sessionId: "sess1",
    indexText: "6",
    parts: ["gold-earner", "toggle", "sess1", "6"],
  });
});

test("roster picker routes classify common picker actions", () => {
  assert.deepEqual(getRosterPickerRoute("add-roster:cancel:abc", { prefix: "add-roster" }), {
    prefix: "add-roster",
    action: ROSTER_PICKER_ACTION.cancel,
    sessionId: "abc",
  });
  assert.deepEqual(getRosterPickerRoute("edit-roster:confirm:def", { prefix: "edit-roster" }), {
    prefix: "edit-roster",
    action: ROSTER_PICKER_ACTION.confirm,
    sessionId: "def",
  });
});

test("roster picker routes parse toggle index and reject bad prefixes/actions", () => {
  assert.deepEqual(getRosterPickerRoute("gold-earner:toggle:sess1:6", { prefix: "gold-earner" }), {
    prefix: "gold-earner",
    action: ROSTER_PICKER_ACTION.toggle,
    sessionId: "sess1",
    index: 6,
  });
  assert.equal(getRosterPickerRoute("gold-earner:toggle:sess1:wat", { prefix: "gold-earner" }).index, null);
  assert.equal(getRosterPickerRoute("edit-roster:toggle:sess1:0", { prefix: "gold-earner" }), null);
  assert.equal(getRosterPickerRoute("gold-earner:nope:sess1", { prefix: "gold-earner" }), null);
});
