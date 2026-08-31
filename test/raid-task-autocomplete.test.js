"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRosterAutocompleteHandlers,
} = require("../bot/handlers/raid/task/autocomplete/roster");
const { clearUserLanguageCache } = require("../bot/services/i18n");

test("raid-task roster autocomplete overlaps own/share reads and reuses locale data", async () => {
  clearUserLanguageCache();
  const events = [];
  let releaseOwn;
  const userDoc = {
    language: "en",
    accounts: [{ accountName: "Main", characters: [] }],
  };
  const { autocompleteRoster } = createRosterAutocompleteHandlers({
    User: {
      findOne() {
        throw new Error("language lookup should reuse the loaded user doc");
      },
    },
    loadUserForAutocomplete: async () => {
      events.push("own-start");
      return new Promise((resolve) => { releaseOwn = resolve; });
    },
    loadAccessibleAccountsForAutocomplete: async () => {
      events.push("accessible-start");
      return [];
    },
    loadUserDocForRosterAutocomplete: async () => userDoc,
  });
  const responses = [];
  const interaction = {
    user: { id: "task-autocomplete-user" },
    respond: async (choices) => { responses.push(choices); },
  };

  const pending = autocompleteRoster(interaction, { value: "" });
  assert.deepEqual(events, ["accessible-start", "own-start"]);
  releaseOwn(userDoc);
  await pending;

  assert.equal(responses.length, 1);
  assert.equal(responses[0][0].value, "Main");
});
