"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeRaidProgress,
  createRaidSetAutocompleteService,
} = require("../bot/handlers/raid/set/autocomplete");
const {
  UI,
  normalizeName,
  toModeLabel,
} = require("../bot/utils/raid/common/shared");
const {
  ensureAssignedRaids,
  getGateKeys,
  RAID_REQUIREMENT_MAP,
} = require("../bot/utils/raid/common/character");
const {
  getRaidRequirementList,
  getGatesForRaid,
} = require("../bot/domain/raid-catalog");
const { clearUserLanguageCache } = require("../bot/services/i18n");

const KAZEROS_HARD = RAID_REQUIREMENT_MAP.kazeros_hard;

function makeCompleteCharacter() {
  return {
    name: "Qiylyn",
    class: "Bard",
    itemLevel: 1730,
    assignedRaids: {
      kazeros: {
        modeKey: "hard",
        G1: { difficulty: "Hard", completedDate: 111 },
        G2: { difficulty: "Hard", completedDate: 222 },
      },
    },
  };
}

function createInteraction({ focused, optionValues }) {
  const responses = [];
  return {
    responses,
    user: { id: `user-${Math.random()}` },
    options: {
      getFocused: () => focused,
      getString: (name) => optionValues[name] || "",
    },
    respond: async (choices) => {
      responses.push(choices);
    },
  };
}

function createService({ userDoc, ...overrides } = {}) {
  const doc = userDoc || {
    accounts: [
      {
        accountName: "Main",
        characters: [makeCompleteCharacter()],
      },
    ],
  };
  return createRaidSetAutocompleteService({
    UI,
    User: {
      findOne: () => ({
        lean: async () => ({ language: "en" }),
      }),
    },
    normalizeName,
    loadUserForAutocomplete: async () => doc,
    getAccessibleAccounts: async () => [],
    flattenRegisteredAccounts: () => [],
    resolveRosterOwner: async () => ({
      ambiguous: false,
      ownerDoc: doc,
    }),
    loadAccountsRegisteredBy: async () => [],
    getRaidRequirementList,
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    ensureAssignedRaids,
    getGateKeys,
    toModeLabel,
    findCharacterInUser: (loadedDoc, characterName, rosterName) => {
      const account = (loadedDoc?.accounts || []).find(
        (entry) => !rosterName || entry.accountName === rosterName
      );
      return (account?.characters || []).find((char) => char.name === characterName) || null;
    },
    ...overrides,
  });
}

test("raid-set autocomplete progress helper marks completed raids as DONE", () => {
  const progress = computeRaidProgress({
    character: makeCompleteCharacter(),
    req: KAZEROS_HARD,
    UI,
    ensureAssignedRaids,
    normalizeName,
    getGatesForRaid,
    getGateKeys,
    toModeLabel,
  });

  assert.equal(progress.done, 2);
  assert.equal(progress.total, 2);
  assert.equal(progress.isComplete, true);
  assert.equal(progress.icon, UI.icons.done);
});

test("raid-set autocomplete status always surfaces Reset for completed raids", async () => {
  clearUserLanguageCache();
  const interaction = createInteraction({
    focused: { name: "status", value: "complete" },
    optionValues: {
      roster: "Main",
      character: "Qiylyn",
      raid: "kazeros_hard",
    },
  });
  const service = createService();

  await service.handleRaidSetAutocomplete(interaction);

  assert.equal(interaction.responses.length, 1);
  assert.deepEqual(interaction.responses[0].map((choice) => choice.value), ["reset"]);
});

test("raid-set autocomplete exposes Solo only for supported raids", async () => {
  clearUserLanguageCache();
  const interaction = createInteraction({
    focused: { name: "raid", value: "solo" },
    optionValues: {
      roster: "Main",
      character: "Qiylyn",
    },
  });
  const service = createService();

  await service.handleRaidSetAutocomplete(interaction);

  assert.equal(interaction.responses.length, 1);
  assert.deepEqual(
    interaction.responses[0].map((choice) => choice.value),
    ["armoche_solo", "kazeros_solo", "serca_solo"],
  );
  assert.equal(
    interaction.responses[0].some((choice) => choice.value === "horizon_solo"),
    false,
  );
});

test("raid-set autocomplete dispatcher returns empty choices for unknown fields", async () => {
  const interaction = createInteraction({
    focused: { name: "unknown", value: "" },
    optionValues: {},
  });
  const service = createService();

  await service.handleRaidSetAutocomplete(interaction);

  assert.deepEqual(interaction.responses, [[]]);
});

test("raid-set roster autocomplete starts independent sources together", async () => {
  clearUserLanguageCache();
  const events = [];
  let releaseOwn;
  const doc = {
    language: "en",
    accounts: [{ accountName: "Main", characters: [] }],
  };
  const service = createService({
    userDoc: doc,
    User: {
      findOne() {
        throw new Error("language lookup should reuse the loaded user doc");
      },
    },
    loadUserForAutocomplete: async () => {
      events.push("own-start");
      return new Promise((resolve) => { releaseOwn = resolve; });
    },
    loadAccountsRegisteredBy: async () => {
      events.push("registered-start");
      return [];
    },
    loadAccessibleAccountsForAutocomplete: async () => {
      events.push("accessible-start");
      return [];
    },
  });
  const interaction = createInteraction({
    focused: { name: "roster", value: "" },
    optionValues: {},
  });

  const pending = service.handleRaidSetAutocomplete(interaction);
  assert.deepEqual(events, [
    "registered-start",
    "accessible-start",
    "own-start",
  ]);
  releaseOwn(doc);
  await pending;

  assert.equal(interaction.responses.length, 1);
  assert.equal(interaction.responses[0][0].value, "Main");
});
