const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shapeOwnedBoardOptions,
  shapeAllOwnedBoardRows,
  chunkBoardOptions,
} = require("../bot/services/raid/schedule/boards/owned-boards");

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

test("shapeAllOwnedBoardRows returns ALL rows (uncapped), still sorted, with creatorId", () => {
  const many = Array.from({ length: 30 }, (_, i) => ev(`e${i}`, new Date(30 - i), { creatorId: `c${i}` }));
  const rows = shapeAllOwnedBoardRows(many, "none");
  assert.equal(rows.length, 30, "no 25-cap on the all-variant");
  // Sorted ascending by startAt -> e29 (date 1) first ... e0 (date 30) last.
  assert.equal(rows[0].eventId, "e29");
  assert.equal(rows[29].eventId, "e0");
  assert.equal(rows[0].creatorId, "c29", "creatorId is shaped through (needed for the teams lead line)");
});

test("shapeAllOwnedBoardRows derives a 6-char shortId from the last hex of _id", () => {
  const [row] = shapeAllOwnedBoardRows([ev("507f1f77bcf86cd799439011", new Date(1))], "none");
  assert.equal(row.shortId, "439011", "last 6 of the ObjectId");
  // Short ids that are already <= 6 chars pass through unchanged.
  assert.equal(shapeAllOwnedBoardRows([ev("abc", new Date(1))], "none")[0].shortId, "abc");
});

test("chunkBoardOptions splits into <= size groups", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ eventId: `e${i}` }));
  const chunks = chunkBoardOptions(rows, 25);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 25);
  assert.equal(chunks[1].length, 5);
  assert.deepEqual(chunkBoardOptions([], 25), []);
  assert.deepEqual(chunkBoardOptions(undefined, 25), []);
  // Defensive: a zero/garbage size never infinite-loops.
  assert.equal(chunkBoardOptions([{ eventId: "a" }], 0).length, 1);
});
