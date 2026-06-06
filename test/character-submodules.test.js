"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const characterFacade = require("../bot/utils/raid/common/character");
const assignedRaids = require("../bot/utils/raid/common/character/assigned-raids");
const {
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  pickUniqueFetchedRosterCandidate,
} = require("../bot/utils/raid/common/character/roster-matching");
const {
  sanitizeSideTasks,
  sanitizeTasks,
} = require("../bot/utils/raid/common/character/task-sanitizers");

test("character facade re-exports extracted roster matching helpers", () => {
  assert.equal(characterFacade.buildFetchedRosterIndexes, buildFetchedRosterIndexes);
  assert.equal(characterFacade.findFetchedRosterMatchForCharacter, findFetchedRosterMatchForCharacter);
  assert.equal(characterFacade.pickUniqueFetchedRosterCandidate, pickUniqueFetchedRosterCandidate);
});

test("character facade re-exports extracted assigned-raid helpers", () => {
  assert.equal(characterFacade.ensureAssignedRaids, assignedRaids.ensureAssignedRaids);
  assert.equal(characterFacade.getCompletedGateKeys, assignedRaids.getCompletedGateKeys);
  assert.equal(characterFacade.normalizeAssignedRaid, assignedRaids.normalizeAssignedRaid);
  assert.equal(characterFacade.RAID_REQUIREMENT_MAP, assignedRaids.RAID_REQUIREMENT_MAP);
});

test("roster matching narrows folded candidates by class and item level", () => {
  const candidates = [
    { charName: "Qiylyn", className: "Bard", itemLevel: 1710 },
    { charName: "Qiylyn", className: "Artist", itemLevel: 1700 },
    { charName: "Qiylyn", className: "Artist", itemLevel: 1715 },
  ];

  assert.deepEqual(
    pickUniqueFetchedRosterCandidate(candidates, {
      class: "Artist",
      itemLevel: 1699.5,
    }),
    candidates[1]
  );
});

test("roster matching keeps exact-name hits before folded disambiguation", () => {
  const fetched = [
    { charName: "Qiylyn", className: "Artist" },
    { charName: "Qiylynx", className: "Bard" },
  ];
  const indexes = buildFetchedRosterIndexes(fetched);

  assert.deepEqual(
    findFetchedRosterMatchForCharacter({ name: "Qiylyn" }, indexes),
    { match: fetched[0], matchType: "exact" }
  );
});

test("task sanitizers filter invalid entries and normalize saved state", () => {
  assert.deepEqual(
    sanitizeTasks([
      { id: 123, completions: "2", completionDate: "99" },
      { completions: 1 },
      null,
    ]),
    [{ id: "123", completions: 2, completionDate: 99 }]
  );

  assert.deepEqual(
    sanitizeSideTasks([
      {
        taskId: 456,
        name: "Chaos Gate",
        reset: "monthly",
        completed: 1,
        lastResetAt: "12",
        createdAt: "34",
      },
      { taskId: "missing-name" },
    ]),
    [
      {
        taskId: "456",
        name: "Chaos Gate",
        reset: "daily",
        completed: true,
        lastResetAt: 12,
        createdAt: 34,
      },
    ]
  );
});
