"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAutoManageAutocompleteChoices,
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
  const redundantOn = getAutoManageStateGate("on", { bibleOn: true, localOn: false });
  assert.equal(redundantOn?.type, "info");
  assert.equal(redundantOn?.titleKey, "raid-auto-manage.redundant.alreadyOnTitle");
  assert.equal(redundantOn?.descriptionKey, "raid-auto-manage.redundant.alreadyOnDescription");
  assert.equal(getAutoManageStateGate("on", { bibleOn: false, localOn: true })?.titleKey, "raid-auto-manage.mutex.bibleBlockedByLocalTitle");
  assert.equal(getAutoManageStateGate("sync", { bibleOn: false, localOn: true })?.titleKey, "raid-auto-manage.sync.localLockedTitle");
  assert.equal(getAutoManageStateGate("local-off", { bibleOn: false, localOn: false })?.titleKey, "raid-auto-manage.redundant.localAlreadyOffTitle");
  assert.equal(getAutoManageStateGate("status", { bibleOn: false, localOn: false }), null);
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
