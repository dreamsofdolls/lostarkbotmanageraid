const test = require("node:test");
const assert = require("node:assert/strict");

const RaidEvent = require("../bot/models/RaidEvent");

function baseFields(extra = {}) {
  return {
    guildId: "g1", channelId: "c1", messageId: "m1", creatorId: "lead1",
    raidKey: "armoche", modeKey: "hard", minItemLevel: 1720,
    partySize: 8, supSlots: 2, dpsSlots: 6, startAt: new Date(),
    ...extra,
  };
}

test("RaidEvent applies lifecycle + policy + auto-lock defaults", () => {
  const ev = new RaidEvent(baseFields());
  assert.equal(ev.status, "open");
  assert.equal(ev.signupPolicy, "open");
  assert.equal(ev.autoLockAtStart, true);
  assert.equal(ev.roomName, null);
  assert.equal(ev.roomPassword, null);
  assert.equal(ev.signups.length, 0);
});

test("RaidEvent rejects an out-of-enum status", () => {
  const ev = new RaidEvent(baseFields({ status: "bogus" }));
  const err = ev.validateSync();
  assert.ok(err && err.errors.status, "expected a validation error on status");
});

test("RaidEvent signup defaults to confirmed with null slot positions", () => {
  const ev = new RaidEvent(baseFields({
    signups: [{
      discordId: "u1", accountName: "Main", characterName: "Senko",
      characterClass: "Bard", characterItemLevel: 1725, role: "support",
    }],
  }));
  assert.equal(ev.signups[0].status, "confirmed");
  assert.equal(ev.signups[0].slotIndex, null);
  assert.equal(ev.signups[0].waitlistPos, null);
});
