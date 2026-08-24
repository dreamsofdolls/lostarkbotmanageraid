"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAutoManageGatherer,
} = require("../bot/services/auto-manage/runtime/pipeline/gather");

test("auto-manage builds one fetched-roster index for every account fallback", async () => {
  const characters = Array.from({ length: 40 }, (_, index) => ({
    name: "char-" + index,
    class: "Artist",
  }));
  const fetchedRoster = characters.map((character) => ({
    charName: character.name.toUpperCase(),
  }));
  let fetchCalls = 0;
  let indexBuildCalls = 0;

  const gatherer = createAutoManageGatherer({
    autoManageEntryKey: (accountName, charName) => accountName + ":" + charName,
    buildFetchedRosterIndexes: (fetched) => {
      indexBuildCalls += 1;
      return new Map(fetched.map((entry) => [entry.charName.toLowerCase(), entry]));
    },
    fetchBibleCharacterMetaWithLimiter: async (name) => {
      if (name === name.toLowerCase()) throw new Error("direct lookup missed");
      return { sn: "sn-" + name, cid: "cid", rid: "rid" };
    },
    fetchBibleLogsSinceWeekReset: async () => [],
    fetchRosterCharacters: async () => {
      fetchCalls += 1;
      return fetchedRoster;
    },
    findFetchedRosterMatchForCharacter: (character, indexes) => {
      const match = indexes.get(character.name.toLowerCase());
      return match ? { match, matchType: "normalized" } : null;
    },
    getCharacterClass: (character) => character.class,
    getCharacterName: (character) => character.name,
    normalizeName: (value) => String(value || "").trim().toLowerCase(),
  });

  const originalWarn = console.warn;
  let entries;
  console.warn = () => {};
  try {
    entries = await gatherer.gatherAutoManageLogsForUserDoc({
      accounts: [{ accountName: "Roster", characters }],
    }, 0);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(entries.length, characters.length);
  assert.equal(fetchCalls, 1, "the shared account seed should fetch once");
  assert.equal(indexBuildCalls, 1, "the same fetched roster should be indexed once");
  assert.ok(entries.every((entry) => entry.error === null));
});
