const test = require("node:test");
const assert = require("node:assert/strict");

const { assignSlots, nextWaitlistPromotion } = require("../bot/services/raid/schedule/slots");
const { applyJoin } = require("../bot/services/raid/schedule/signup-state");

const sigs = [
  { discordId: "a", role: "support", status: "confirmed", joinedAt: 1 },
  { discordId: "b", role: "support", status: "confirmed", joinedAt: 2 },
  { discordId: "c", role: "support", status: "confirmed", joinedAt: 3 }, // overflow (8-man = 2 sup)
  { discordId: "d", role: "dps", status: "late", joinedAt: 4 },          // late still holds a slot
  { discordId: "e", role: "dps", status: "tentative", joinedAt: 5 },     // excluded - no slot
];

test("assignSlots fills by join order, overflow to waitlist, by role", () => {
  const { support, dps, waitlist } = assignSlots(sigs, { supSlots: 2, dpsSlots: 6 });
  assert.deepEqual(support.map((s) => s.discordId), ["a", "b"]);
  assert.deepEqual(dps.map((s) => s.discordId), ["d"]);          // 'e' tentative excluded
  assert.deepEqual(waitlist.map((s) => s.discordId), ["c"]);     // 3rd support overflows
});

test("nextWaitlistPromotion returns the first waitlisted of the freed role", () => {
  // c (support) is waitlisted; freeing a support slot should promote c.
  assert.equal(nextWaitlistPromotion(sigs, { supSlots: 2, dpsSlots: 6 }, "support").discordId, "c");
  // No dps is waitlisted, so a freed dps slot has no promotion.
  assert.equal(nextWaitlistPromotion(sigs, { supSlots: 2, dpsSlots: 6 }, "dps"), null);
});

test("manager-added signups follow normal role capacity and can land on waitlist", () => {
  const existing = [
    { discordId: "a", role: "dps", status: "confirmed", joinedAt: 1 },
  ];
  const afterAdd = applyJoin(
    existing,
    {
      discordId: "b",
      accountName: "Alt",
      characterName: "Newdps",
      characterClass: "Berserker",
      characterItemLevel: 1720,
    },
    2,
  );

  const { dps, waitlist } = assignSlots(afterAdd, { supSlots: 0, dpsSlots: 1 });
  assert.deepEqual(dps.map((s) => s.discordId), ["a"]);
  assert.deepEqual(waitlist.map((s) => s.discordId), ["b"]);
});
