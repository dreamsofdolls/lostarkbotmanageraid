"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeAllModePendingAggregate,
} = require("../bot/handlers/raid-check/all-mode/all-mode-aggregate");

function createPage(discordId, characters) {
  return {
    userDoc: { discordId },
    account: { characters },
  };
}

function raid(raidKey, modeKey, isCompleted = false) {
  return { raidKey, modeKey, isCompleted };
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
