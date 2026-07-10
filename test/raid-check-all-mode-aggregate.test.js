"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAllModePendingAggregateCache,
  computeAllModePendingAggregate,
} = require("../bot/handlers/raid-check/all-mode/all-mode-aggregate");

function createPage(discordId, characters) {
  return {
    userDoc: { discordId },
    account: { characters },
  };
}

function raid(raidKey, modeKey, isCompleted = false, extras = {}) {
  return { raidKey, modeKey, isCompleted, ...extras };
}

const pagesData = [
  createPage("user-a", [
    {
      class: "Artist",
      raids: [
        raid("act4", "normal"),
        raid("kazeros", "hard", true),
      ],
    },
    {
      class: "Slayer",
      raids: [
        raid("act4", "normal"),
        raid("serca", "hard"),
      ],
    },
  ]),
  createPage("user-b", [
    {
      class: "Bard",
      raids: [raid("act4", "normal")],
    },
  ]),
];

const getStatusRaidsForCharacter = (character) => character.raids;

test("raid-check all-mode aggregate counts pending by user, raid, and role bucket", () => {
  const aggregate = computeAllModePendingAggregate({
    pagesData,
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 4);

  assert.deepEqual(aggregate.perUserPending.get("user-a"), {
    count: 3,
    supports: 1,
    dps: 2,
  });
  assert.deepEqual(aggregate.perUserPending.get("user-b"), {
    count: 1,
    supports: 1,
    dps: 0,
  });

  const act4 = aggregate.perRaidPending.get("act4:normal");
  assert.equal(act4.pending, 3);
  assert.equal(act4.supports, 2);
  assert.equal(act4.dps, 1);
  assert.match(act4.label, /Normal/);
});

test("raid-check all-mode aggregate keeps completed raid entries visible with zero pending", () => {
  const aggregate = computeAllModePendingAggregate({
    pagesData,
    getStatusRaidsForCharacter,
    lang: "en",
  });

  const kazeros = aggregate.perRaidPending.get("kazeros:hard");
  assert.ok(kazeros);
  assert.equal(kazeros.pending, 0);
  assert.equal(kazeros.supports, 0);
  assert.equal(kazeros.dps, 0);
});

test("raid-check all-mode aggregate scopes pending counts by active raid filter", () => {
  const aggregate = computeAllModePendingAggregate({
    pagesData,
    raidFilter: "serca:hard",
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 1);
  assert.deepEqual(aggregate.perUserPending.get("user-a"), {
    count: 1,
    supports: 0,
    dps: 1,
  });
  assert.equal(aggregate.perUserPending.has("user-b"), false);
});

test("raid-check all-mode aggregate scopes raid dropdown counts by active user filter", () => {
  const aggregate = computeAllModePendingAggregate({
    pagesData,
    userFilter: "user-b",
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 1);
  assert.equal(aggregate.perRaidPending.get("act4:normal").pending, 1);
  assert.equal(aggregate.perRaidPending.has("serca:hard"), false);
});

test("raid-check all-mode aggregate excludes raids that do not receive gold", () => {
  const aggregate = computeAllModePendingAggregate({
    pagesData: [
      createPage("user-a", [
        {
          class: "Artist",
          raids: [
            raid("act4", "hard", false, { goldReceives: false }),
            raid("kazeros", "hard", false, { goldReceives: true }),
          ],
        },
      ]),
      createPage("user-b", [
        {
          class: "Slayer",
          raids: [
            raid("act4", "hard", false, { goldReceives: false }),
          ],
        },
      ]),
    ],
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 1);
  assert.deepEqual(aggregate.perUserPending.get("user-a"), {
    count: 1,
    supports: 1,
    dps: 0,
  });
  assert.equal(aggregate.perUserPending.has("user-b"), false);
  assert.equal(aggregate.perRaidPending.has("act4:hard"), false);
  assert.equal(aggregate.perRaidPending.get("kazeros:hard").pending, 1);
});

test("raid-check all-mode aggregate excludes Solo raids even when they receive gold", () => {
  const aggregate = computeAllModePendingAggregate({
    pagesData: [
      createPage("user-a", [
        {
          class: "Artist",
          raids: [
            raid("act4", "solo", false, { goldReceives: true }),
            raid("kazeros", "normal", false, { goldReceives: true }),
          ],
        },
      ]),
    ],
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 1);
  assert.equal(aggregate.perRaidPending.has("act4:solo"), false);
  assert.equal(aggregate.perRaidPending.get("kazeros:normal").pending, 1);
});

test("raid-check all-mode aggregate cache reuses scans and character raid derivation", () => {
  let raidReads = 0;
  const cache = createAllModePendingAggregateCache({
    pagesData,
    getStatusRaidsForCharacter: (character) => {
      raidReads += 1;
      return character.raids;
    },
    lang: "en",
  });

  const first = cache.compute({ raidFilter: null, userFilter: null });
  const repeated = cache.compute({ raidFilter: null, userFilter: null });
  assert.strictEqual(repeated, first);
  assert.equal(raidReads, 3);

  cache.compute({ raidFilter: "act4:normal", userFilter: null });
  assert.equal(raidReads, 3);

  cache.clear();
  cache.compute({ raidFilter: null, userFilter: null });
  assert.equal(raidReads, 6);
});
