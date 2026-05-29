const test = require("node:test");
const assert = require("node:assert/strict");

const { selectAutoClearTargets } = require("../bot/services/raid/schedule/auto-clear");

test("selectAutoClearTargets returns confirmed + late, with raid gates", () => {
  const event = {
    raidKey: "armoche",
    modeKey: "hard",
    signups: [
      { discordId: "a", accountName: "Main", characterName: "Senko", status: "confirmed" },
      { discordId: "b", accountName: "Alt", characterName: "Latedps", status: "late" },
      { discordId: "c", accountName: "Main", characterName: "Maybe", status: "tentative" },
      { discordId: "d", accountName: "Main", characterName: "Bench", status: "waitlisted" },
    ],
  };
  const targets = selectAutoClearTargets(event);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((t) => t.characterName), ["Senko", "Latedps"]);
  assert.deepEqual(targets[0], {
    discordId: "a",
    accountName: "Main",
    characterName: "Senko",
    raidKey: "armoche",
    modeKey: "hard",
    gates: ["G1", "G2"],
  });
});

test("selectAutoClearTargets is safe on an empty / malformed event", () => {
  assert.deepEqual(selectAutoClearTargets(null), []);
  assert.deepEqual(selectAutoClearTargets({ raidKey: "armoche" }), []);
});
