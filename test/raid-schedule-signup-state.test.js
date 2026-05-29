const test = require("node:test");
const assert = require("node:assert/strict");

const { applyJoin, applyRsvp, applyLeave } = require("../bot/services/raid/schedule/signup-state");
const { detectPromotion } = require("../bot/services/raid/schedule/slots");

const COUNTS = { supSlots: 1, dpsSlots: 1 };

function joinPayload(id, cls) {
  return {
    discordId: id, accountName: "Main", characterName: `${id}-char`,
    characterClass: cls, characterItemLevel: 1720,
  };
}

test("applyJoin adds a confirmed signup with derived role", () => {
  const after = applyJoin([], joinPayload("a", "Bard"), 100);
  assert.equal(after.length, 1);
  assert.equal(after[0].status, "confirmed");
  assert.equal(after[0].role, "support");
  assert.equal(after[0].joinedAt, 100);
});

test("applyJoin re-join preserves original joinedAt, swaps character", () => {
  const first = applyJoin([], joinPayload("a", "Bard"), 100);
  const second = applyJoin(first, { ...joinPayload("a", "Berserker"), characterName: "newchar" }, 200);
  assert.equal(second.length, 1);
  assert.equal(second[0].joinedAt, 100);          // position kept
  assert.equal(second[0].role, "dps");            // class swap re-derives role
  assert.equal(second[0].characterName, "newchar");
});

test("applyRsvp flips an existing signup; no-op when not joined", () => {
  const joined = applyJoin([], joinPayload("a", "Bard"), 100);
  const late = applyRsvp(joined, "a", "late");
  assert.equal(late.ok, true);
  assert.equal(late.signups[0].status, "late");

  const miss = applyRsvp(joined, "ghost", "tentative");
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, "not-joined");

  assert.throws(() => applyRsvp(joined, "a", "bogus"), /invalid RSVP status/);
});

test("applyLeave removes the signup and reports whether anything changed", () => {
  const joined = applyJoin([], joinPayload("a", "Bard"), 100);
  const left = applyLeave(joined, "a");
  assert.equal(left.ok, true);
  assert.equal(left.signups.length, 0);
  assert.equal(applyLeave(joined, "ghost").ok, false);
});

test("detectPromotion finds the waitlister pulled into a freed slot", () => {
  // 2 dps, 1 dps slot: 'a' in slot, 'b' waitlisted.
  let signups = applyJoin([], joinPayload("a", "Berserker"), 1);
  signups = applyJoin(signups, joinPayload("b", "Berserker"), 2);
  // 'a' leaves -> 'b' should be promoted into the comp.
  const after = applyLeave(signups, "a").signups;
  const promoted = detectPromotion(signups, after, COUNTS);
  assert.deepEqual(promoted.map((s) => s.discordId), ["b"]);

  // No vacancy change -> no promotion.
  assert.deepEqual(detectPromotion(signups, signups, COUNTS), []);
});
