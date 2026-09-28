const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addTurn,
  setTurnMembers,
  removeMembersFromTurns,
  resolveTurnMembers,
} = require("../bot/services/raid/schedule/turns");

test("addTurn appends an empty turn", () => {
  const turns = addTurn([], "Turn 1");
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0], { name: "Turn 1", memberIds: [] });
});

test("setTurnMembers replaces one turn (deduped), leaves others, allows overlap", () => {
  let turns = addTurn(addTurn([], "Turn 1"), "Turn 2");
  turns = setTurnMembers(turns, 0, ["a", "b", "a"]); // dedup
  assert.deepEqual(turns[0].memberIds, ["a", "b"]);
  assert.deepEqual(turns[1].memberIds, []);
  // overlap: 'a' can also be in turn 2
  turns = setTurnMembers(turns, 1, ["a"]);
  assert.deepEqual(turns[1].memberIds, ["a"]);
  assert.deepEqual(turns[0].memberIds, ["a", "b"]); // turn 1 untouched
});

test("setTurnMembers keeps turn members the picker could not list", () => {
  // "late" sits past the 25-option picker; "gone" already left the pool.
  const turns = [
    { name: "Turn 1", memberIds: ["a", "late", "gone"] },
    { name: "Turn 2", memberIds: ["late"] },
  ];
  const next = setTurnMembers(turns, 0, ["b"], ["late", "other"]);
  assert.deepEqual(next[0].memberIds, ["b", "late"]);
  assert.deepEqual(next[1].memberIds, ["late"]);
});

test("removeMembersFromTurns drops kicked ids from every turn", () => {
  const turns = [
    { name: "Turn 1", memberIds: ["a", "b", "c"] },
    { name: "Turn 2", memberIds: ["a", "d"] },
  ];
  const next = removeMembersFromTurns(turns, ["a", "c", "ghost"]);
  assert.deepEqual(next, [
    { name: "Turn 1", memberIds: ["b"] },
    { name: "Turn 2", memberIds: ["d"] },
  ]);
  assert.deepEqual(turns[0].memberIds, ["a", "b", "c"]); // input untouched
});

test("resolveTurnMembers maps ids to signups + role, drops missing", () => {
  const signups = [
    { discordId: "a", characterName: "Senko", characterClass: "Bard", characterItemLevel: 1725 },
    { discordId: "b", characterName: "Morrah", characterClass: "Berserker", characterItemLevel: 1722 },
  ];
  const turn = { name: "Turn 1", memberIds: ["a", "b", "ghost"] };
  const members = resolveTurnMembers(signups, turn);
  assert.equal(members.length, 2); // 'ghost' (left the pool) dropped
  assert.equal(members[0].role, "support");
  assert.equal(members[0].characterName, "Senko");
  assert.equal(members[1].role, "dps");
});
