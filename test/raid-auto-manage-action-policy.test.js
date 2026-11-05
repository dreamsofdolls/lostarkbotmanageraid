"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAutoManageAutocompleteChoices,
  buildAutoManageStateNotice,
  getAutoManageStateGate,
  isValidAutoManageAction,
  shouldReadAutoManageState,
} = require("../bot/handlers/raid/auto-manage/action-policy");

function fakeT(key) {
  return key;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

test("auto-manage action policy validates supported slash actions", () => {
  for (const action of ["on", "off", "sync", "status", "local-on", "local-off", "reset"]) {
    assert.equal(isValidAutoManageAction(action), true);
  }
  assert.equal(isValidAutoManageAction("bogus"), false);
});

test("auto-manage state policy gates redundant and mutex actions", () => {
  assert.equal(getAutoManageStateGate("on", { bibleOn: true, localOn: false })?.notice, "alreadyOn");
  assert.equal(getAutoManageStateGate("on", { bibleOn: false, localOn: true })?.notice, "bibleBlockedByLocal");
  assert.equal(getAutoManageStateGate("sync", { bibleOn: false, localOn: true })?.notice, "localLocked");
  assert.equal(getAutoManageStateGate("local-off", { bibleOn: false, localOn: false })?.notice, "localAlreadyOff");
  assert.equal(getAutoManageStateGate("status", { bibleOn: false, localOn: false }), null);
});

test("auto-manage state notices: already on or off is input, a mode conflict is guard", () => {
  const redundantOn = buildAutoManageStateNotice("alreadyOn", "en");
  assert.equal(redundantOn.kind, "input");
  assert.equal(redundantOn.title, "Auto-manage is already on");
  assert.ok(redundantOn.tip);
  for (const name of ["bibleBlockedByLocal", "localBlockedByBible", "localLocked"]) {
    assert.equal(buildAutoManageStateNotice(name, "en").kind, "guard", name);
  }
});

test("auto-manage state policy limits the pre-read to state-sensitive actions", () => {
  assert.equal(shouldReadAutoManageState("on"), true);
  assert.equal(shouldReadAutoManageState("sync"), true);
  assert.equal(shouldReadAutoManageState("status"), false);
  assert.equal(shouldReadAutoManageState("reset"), false);
});

test("auto-manage autocomplete choices mirror bible/local mutex state", () => {
  const offChoices = buildAutoManageAutocompleteChoices({
    bibleOn: false,
    localOn: false,
    lang: "vi",
    t: fakeT,
    normalizeName,
  }).map((choice) => choice.value);
  assert.deepEqual(offChoices, ["on", "sync", "status", "local-on", "reset"]);

  const bibleChoices = buildAutoManageAutocompleteChoices({
    bibleOn: true,
    localOn: false,
    lang: "vi",
    t: fakeT,
    normalizeName,
  }).map((choice) => choice.value);
  assert.deepEqual(bibleChoices, ["off", "sync", "status", "reset"]);

  const localChoices = buildAutoManageAutocompleteChoices({
    bibleOn: false,
    localOn: true,
    lang: "vi",
    t: fakeT,
    normalizeName,
  }).map((choice) => choice.value);
  assert.deepEqual(localChoices, ["status", "local-off", "reset"]);
});

test("auto-manage autocomplete choices filter by localized label or value", () => {
  const choices = buildAutoManageAutocompleteChoices({
    bibleOn: false,
    localOn: false,
    needle: "local",
    lang: "vi",
    t: fakeT,
    normalizeName,
  }).map((choice) => choice.value);
  assert.deepEqual(choices, ["local-on"]);
});
