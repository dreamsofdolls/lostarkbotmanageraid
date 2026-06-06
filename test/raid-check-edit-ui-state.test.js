"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePickedRaidLabel,
  resolveRaidCheckEditEmbedState,
} = require("../bot/handlers/raid-check/edit/edit-ui/state");

const raidRequirementMap = {
  act4_normal: {
    raidKey: "act4",
    modeKey: "normal",
    minItemLevel: 1700,
  },
};

function createState(overrides = {}) {
  return {
    applied: false,
    scopeAll: false,
    raidMeta: raidRequirementMap.act4_normal,
    editableByUser: new Map(),
    displayMap: new Map(),
    preSelectedUserId: null,
    preSelectedDisplayName: null,
    selectedUser: null,
    selectedChar: null,
    selectedRaid: "act4_normal",
    awaitingGate: false,
    ...overrides,
  };
}

test("raid-check edit state resolves picked raid labels from the requirement map", () => {
  assert.equal(
    resolvePickedRaidLabel({
      state: createState(),
      raidRequirementMap,
      lang: "en",
    }),
    "Act4 Normal"
  );
});

test("raid-check edit state shows scope-all preselect context before raid pick", () => {
  const state = createState({
    scopeAll: true,
    raidMeta: null,
    selectedRaid: null,
    preSelectedUserId: "100",
    preSelectedDisplayName: "Traine",
  });

  const resolved = resolveRaidCheckEditEmbedState({
    state,
    raidRequirementMap,
    lang: "en",
  });

  assert.match(resolved.nextStep, /Pick \*\*raid \+ difficulty\*\* first/);
  assert.match(resolved.userLabel, /Traine/);
  assert.equal(resolved.charLabel, "_not picked_");
  assert.equal(resolved.raidLabel, "_not picked_");
  assert.match(resolved.headerLine, /Pick \*\*raid \+ difficulty\*\* first/);
});

test("raid-check edit state renders selected user and locked raid context", () => {
  const state = createState({
    displayMap: new Map([["100", "Qiylyn Owner"]]),
    selectedUser: "100",
    selectedChar: {
      charName: "Qiylyn",
      itemLevel: 1700.4,
      publicLogDisabled: true,
    },
  });

  const resolved = resolveRaidCheckEditEmbedState({
    state,
    raidRequirementMap,
    lang: "en",
  });

  assert.equal(resolved.userLabel, "Qiylyn Owner");
  assert.match(resolved.charLabel, /Qiylyn/);
  assert.match(resolved.charLabel, /1700/);
  assert.match(resolved.charLabel, /log off/);
  assert.match(resolved.raidLineSuffix, /locked to/);
  assert.match(resolved.nextStep, /Finally click/);
});

test("raid-check edit state switches next step to gate selection", () => {
  const state = createState({
    selectedUser: "100",
    selectedChar: { charName: "Qiylyn", itemLevel: 1700 },
    awaitingGate: true,
  });

  const resolved = resolveRaidCheckEditEmbedState({
    state,
    raidRequirementMap,
    lang: "en",
  });

  assert.match(resolved.nextStep, /Pick a \*\*gate\*\*/);
});
