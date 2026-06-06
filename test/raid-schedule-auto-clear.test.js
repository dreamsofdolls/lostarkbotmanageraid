const test = require("node:test");
const assert = require("node:assert/strict");

const { selectAutoClearTargets } = require("../bot/services/raid/schedule/lifecycle/auto-clear");

test("selectAutoClearTargets credits the filled comp (confirmed + late in a slot)", () => {
  const event = {
    raidKey: "armoche",
    modeKey: "hard",
    supSlots: 1,
    dpsSlots: 1,
    signups: [
      { discordId: "a", accountName: "Main", characterName: "Senko", role: "support", status: "confirmed", joinedAt: 1 },
      { discordId: "b", accountName: "Alt", characterName: "Latedps", role: "dps", status: "late", joinedAt: 2 },
      { discordId: "c", accountName: "Main", characterName: "Maybe", role: "dps", status: "tentative", joinedAt: 3 },
    ],
  };
  const targets = selectAutoClearTargets(event);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((t) => t.characterName).sort(), ["Latedps", "Senko"]);
  const senko = targets.find((t) => t.characterName === "Senko");
  assert.deepEqual(senko, {
    discordId: "a",
    accountName: "Main",
    characterName: "Senko",
    raidKey: "armoche",
    modeKey: "hard",
    gates: ["G1", "G2"],
  });
});

test("selectAutoClearTargets does NOT credit waitlist overflow", () => {
  // 2 dps confirmed but only 1 dps slot -> the 2nd (later joinedAt) overflows
  // to the waitlist and must not be credited (they didn't raid).
  const event = {
    raidKey: "armoche",
    modeKey: "hard",
    supSlots: 1,
    dpsSlots: 1,
    signups: [
      { discordId: "a", accountName: "Main", characterName: "Indps", role: "dps", status: "confirmed", joinedAt: 1 },
      { discordId: "b", accountName: "Alt", characterName: "Overflow", role: "dps", status: "confirmed", joinedAt: 2 },
    ],
  };
  const targets = selectAutoClearTargets(event);
  assert.deepEqual(targets.map((t) => t.characterName), ["Indps"]);
});

test("selectAutoClearTargets is safe on an empty / malformed event", () => {
  assert.deepEqual(selectAutoClearTargets(null), []);
  assert.deepEqual(selectAutoClearTargets({ raidKey: "armoche" }), []);
});
