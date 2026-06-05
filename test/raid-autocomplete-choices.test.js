"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRosterAutocompleteChoices,
  buildSharedRosterAutocompleteChoices,
} = require("../bot/utils/raid/common/autocomplete");

function fakeT(key, lang, vars = {}) {
  if (key === "share.accessLevel.view") return "view";
  if (key.endsWith("sharedAccessTagView")) return `[${vars.viewLabel}]`;
  return [
    key,
    lang,
    vars.name,
    vars.charCount,
    vars.charsWord,
    vars.taskSuffix || "",
    vars.owner || "",
    vars.accessTag || "",
  ].join("|");
}

function charsWord(n) {
  return `${n} chars`;
}

function taskSuffixFor(n) {
  return n > 0 ? `${n} tasks` : "";
}

test("buildRosterAutocompleteChoices formats own roster choices with optional task suffix", () => {
  const choices = buildRosterAutocompleteChoices(
    [
      {
        accountName: "Main",
        characters: [
          { name: "Aki", sideTasks: [{ taskId: "one" }, { taskId: "two" }] },
          { name: "Bao", sideTasks: [{ taskId: "three" }] },
        ],
      },
    ],
    {
      lang: "en",
      t: fakeT,
      choiceKey: "raid-task.autocomplete.ownChoice",
      charsWord,
      taskSuffixFor,
    },
  );

  assert.deepEqual(choices, [
    {
      name: "raid-task.autocomplete.ownChoice|en|Main|2|2 chars|3 tasks||",
      value: "Main",
    },
  ]);
});

test("buildSharedRosterAutocompleteChoices filters shares and carries view-only tags", () => {
  const choices = buildSharedRosterAutocompleteChoices(
    [
      { isOwn: true, accountName: "Alpha" },
      {
        isOwn: false,
        accountName: "Alpha Share",
        ownerLabel: "Owner One",
        accessLevel: "view",
        account: {
          characters: [{ name: "Aki", sideTasks: [{ taskId: "one" }] }],
        },
      },
      {
        isOwn: false,
        accountName: "Beta Share",
        ownerLabel: "Owner Two",
        accessLevel: "edit",
        account: { characters: [{ name: "Bao" }] },
      },
    ],
    {
      needle: "alpha",
      lang: "en",
      t: fakeT,
      choiceKey: "raid-task.autocomplete.sharedChoice",
      accessTagKey: "raid-task.autocomplete.sharedAccessTagView",
      charsWord,
      taskSuffixFor,
    },
  );

  assert.deepEqual(choices, [
    {
      name: "raid-task.autocomplete.sharedChoice|en|Alpha Share|1|1 chars|1 tasks|Owner One|[view]",
      value: "Alpha Share",
    },
  ]);
});
