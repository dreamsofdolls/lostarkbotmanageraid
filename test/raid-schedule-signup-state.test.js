const test = require("node:test");
const assert = require("node:assert/strict");

const { applyJoin, applyRsvp, applyLeave, applyKick } = require("../bot/services/raid/schedule/signup-state");
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

test("applyKick removes one or more signups and reports the dropped records", () => {
  let signups = applyJoin([], joinPayload("a", "Bard"), 1);
  signups = applyJoin(signups, joinPayload("b", "Berserker"), 2);
  signups = applyJoin(signups, joinPayload("c", "Sorceress"), 3);

  const one = applyKick(signups, ["b"]);
  assert.equal(one.signups.length, 2);
  assert.deepEqual(one.removed.map((s) => s.discordId), ["b"]);
  assert.ok(!one.signups.some((s) => s.discordId === "b"));

  const many = applyKick(signups, ["a", "c"]);
  assert.equal(many.signups.length, 1);
  assert.deepEqual(many.removed.map((s) => s.discordId).sort(), ["a", "c"]);
  assert.equal(many.signups[0].discordId, "b");
});

test("applyKick ignores absent ids and is safe on empty input", () => {
  const signups = applyJoin([], joinPayload("a", "Bard"), 1);
  const miss = applyKick(signups, ["ghost"]);
  assert.equal(miss.signups.length, 1);            // untouched
  assert.deepEqual(miss.removed, []);              // nothing actually removed
  assert.deepEqual(applyKick(signups, []).removed, []); // empty selection = no-op
  assert.deepEqual(applyKick(undefined, ["a"]), { signups: [], removed: [] });
});

test("applyKick frees a slot so detectPromotion pulls the waitlister", () => {
  // COUNTS = 1 dps slot: 'a' in slot, 'b' waitlisted.
  let signups = applyJoin([], joinPayload("a", "Berserker"), 1);
  signups = applyJoin(signups, joinPayload("b", "Berserker"), 2);
  const after = applyKick(signups, ["a"]).signups;
  const promoted = detectPromotion(signups, after, COUNTS);
  assert.deepEqual(promoted.map((s) => s.discordId), ["b"]);
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
