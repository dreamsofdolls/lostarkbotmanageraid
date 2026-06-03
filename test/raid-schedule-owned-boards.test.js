const test = require("node:test");
const assert = require("node:assert/strict");

const { shapeOwnedBoardOptions } = require("../bot/services/raid/schedule/owned-boards");

function sup(id, joinedAt = 1) {
  return {
    discordId: id, characterName: `S${id}`, characterClass: "Bard",
    characterItemLevel: 1720, role: "support", status: "confirmed", joinedAt,
  };
}
function dps(id, joinedAt = 2, status = "confirmed") {
  return {
    discordId: id, characterName: `D${id}`, characterClass: "Berserker",
    characterItemLevel: 1720, role: "dps", status, joinedAt,
  };
}

function ev(id, startAt, overrides = {}) {
  return {
    _id: id, raidKey: "armoche", modeKey: "hard", channelId: `chan-${id}`,
    partySize: 8, supSlots: 2, dpsSlots: 6, startAt,
    signups: [], ...overrides,
  };
}

test("shapeOwnedBoardOptions sorts by startAt ascending (soonest first)", () => {
  const rows = shapeOwnedBoardOptions(
    [
      ev("late", new Date(Date.UTC(2026, 5, 5, 13, 0))),
      ev("soon", new Date(Date.UTC(2026, 5, 3, 13, 0))),
      ev("mid", new Date(Date.UTC(2026, 5, 4, 13, 0))),
    ],
    "mid",
  );
  assert.deepEqual(rows.map((r) => r.eventId), ["soon", "mid", "late"]);
});

test("shapeOwnedBoardOptions marks isCurrent for the active board only", () => {
  const rows = shapeOwnedBoardOptions(
    [ev("a", new Date(1)), ev("b", new Date(2)), ev("c", new Date(3))],
    "b",
  );
  assert.deepEqual(rows.map((r) => r.isCurrent), [false, true, false]);
});

test("shapeOwnedBoardOptions derives comp + waitlist counts via assignSlots", () => {
  // 1 sup slot + 1 dps slot. 1 sup + 2 dps -> comp 2 (1 sup + 1 dps), 1 dps overflow.
  const row = shapeOwnedBoardOptions(
    [ev("a", new Date(1), {
      supSlots: 1, dpsSlots: 1, partySize: 2,
      signups: [sup("s1"), dps("d1", 2), dps("d2", 3)],
    })],
    "a",
  )[0];
  assert.equal(row.compCount, 2);
  assert.equal(row.partySize, 2);
  assert.equal(row.waitlistCount, 1);
  assert.equal(row.channelId, "chan-a");
  assert.equal(row.raidKey, "armoche");
});

test("shapeOwnedBoardOptions caps at 25 options", () => {
  const many = Array.from({ length: 30 }, (_, i) => ev(`e${i}`, new Date(i + 1)));
  const rows = shapeOwnedBoardOptions(many, "e0");
  assert.equal(rows.length, 25);
  // Kept the 25 soonest (e0..e24 by ascending startAt).
  assert.equal(rows[0].eventId, "e0");
  assert.equal(rows[24].eventId, "e24");
});

test("shapeOwnedBoardOptions is safe on empty / missing input", () => {
  assert.deepEqual(shapeOwnedBoardOptions([], "x"), []);
  assert.deepEqual(shapeOwnedBoardOptions(undefined, "x"), []);
  assert.deepEqual(shapeOwnedBoardOptions(null, "x"), []);
});
