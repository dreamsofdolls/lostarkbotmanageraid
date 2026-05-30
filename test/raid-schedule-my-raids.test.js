const test = require("node:test");
const assert = require("node:assert/strict");

const {
  turnsForMember,
  shapeMyRaidEvents,
  buildMyRaidDetail,
} = require("../bot/services/raid/schedule/my-raids");

function sup(id, name) {
  return {
    discordId: id, characterName: name, characterClass: "Bard",
    characterItemLevel: 1720, role: "support", status: "confirmed", joinedAt: 1,
  };
}
function dps(id, name, status = "confirmed", joinedAt = 2) {
  return {
    discordId: id, characterName: name, characterClass: "Berserker",
    characterItemLevel: 1720, role: "dps", status, joinedAt,
  };
}

test("turnsForMember keeps only the turns containing the member", () => {
  const turns = [
    { name: "Turn 1", memberIds: ["a", "b"] },
    { name: "Turn 2", memberIds: ["c"] },
    { name: "Turn 3", memberIds: ["a"] },
  ];
  assert.deepEqual(turnsForMember(turns, "a").map((tn) => tn.name), ["Turn 1", "Turn 3"]);
  assert.deepEqual(turnsForMember(turns, "c").map((tn) => tn.name), ["Turn 2"]);
  assert.deepEqual(turnsForMember(turns, "z"), []);   // not in any turn
  assert.deepEqual(turnsForMember(undefined, "a"), []); // safe on missing
});

test("shapeMyRaidEvents includes only events the viewer signed up for, with char/role + turn count", () => {
  const events = [
    {
      _id: "e1", raidKey: "armoche", modeKey: "hard", channelId: "c1",
      startAt: new Date(Date.UTC(2026, 4, 30, 13, 0)),
      signups: [sup("a", "Senko"), dps("b", "Morrah")],
      turns: [{ name: "T1", memberIds: ["a"] }, { name: "T2", memberIds: ["a", "b"] }],
    },
    {
      _id: "e2", raidKey: "kazeros", modeKey: "hard", channelId: "c2",
      startAt: new Date(Date.UTC(2026, 4, 30, 14, 0)),
      signups: [dps("b", "Morrah")], // viewer 'a' is NOT in this one
      turns: [],
    },
  ];
  const shaped = shapeMyRaidEvents(events, "a");
  assert.equal(shaped.length, 1);
  assert.equal(shaped[0].eventId, "e1");
  assert.equal(shaped[0].characterName, "Senko");
  assert.equal(shaped[0].role, "support");
  assert.equal(shaped[0].turnCount, 2);     // 'a' is in both turns
  assert.equal(shaped[0].raidKey, "armoche");
  assert.equal(shaped[0].channelId, "c1");
});

test("buildMyRaidDetail flags inComp for slot-holders and lists the viewer's turns", () => {
  const COUNTS = { supSlots: 1, dpsSlots: 1 };
  const event = {
    // sup slot=1 -> 'a' in; dps slot=1 -> 'b' (joinedAt 2) in, 'c' (joinedAt 3) overflow.
    signups: [sup("a", "Senko"), dps("b", "Morrah"), dps("c", "Extra", "confirmed", 3)],
    turns: [{ name: "T1", memberIds: ["a"] }],
  };
  const detailA = buildMyRaidDetail(event, "a", COUNTS);
  assert.equal(detailA.inComp, true);
  assert.equal(detailA.role, "support");
  assert.deepEqual(detailA.turns.map((tn) => tn.name), ["T1"]);
  assert.equal(detailA.signup.characterName, "Senko");

  const detailC = buildMyRaidDetail(event, "c", COUNTS);
  assert.equal(detailC.inComp, false);   // 'c' overflowed to the waitlist
  assert.deepEqual(detailC.turns, []);

  assert.equal(buildMyRaidDetail(event, "z", COUNTS).signup, null); // not signed up
});
