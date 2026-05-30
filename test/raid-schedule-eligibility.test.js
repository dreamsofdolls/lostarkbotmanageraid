const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveRole,
  hasClearedRaid,
  listEligibleCharacters,
  partitionSelectable,
} = require("../bot/services/raid/schedule/eligibility");

test("deriveRole maps support classes vs dps", () => {
  assert.equal(deriveRole("Bard"), "support");
  assert.equal(deriveRole("Paladin"), "support");
  assert.equal(deriveRole("Berserker"), "dps");
  assert.equal(deriveRole(""), "dps");
});

test("hasClearedRaid is true only when all gates have a completion", () => {
  const cleared = { assignedRaids: { armoche: { G1: { completedDate: 1 }, G2: { completedDate: 2 } } } };
  const partial = { assignedRaids: { armoche: { G1: { completedDate: 1 } } } };
  const none = { assignedRaids: {} };
  assert.equal(hasClearedRaid(cleared, "armoche"), true);
  assert.equal(hasClearedRaid(partial, "armoche"), false);
  assert.equal(hasClearedRaid(none, "armoche"), false);
});

test("listEligibleCharacters flags iLvl gate, role, deficit, cleared", () => {
  const accounts = [
    {
      accountName: "Main",
      characters: [
        { name: "Senko", class: "Bard", itemLevel: 1725, assignedRaids: {} },
        { name: "Morrah", class: "Berserker", itemLevel: 1722,
          assignedRaids: { armoche: { G1: { completedDate: 1 }, G2: { completedDate: 1 } } } },
        { name: "Lowblade", class: "Deathblade", itemLevel: 1715, assignedRaids: {} },
      ],
    },
  ];
  const rows = listEligibleCharacters(accounts, { raidKey: "armoche", minItemLevel: 1720 });
  assert.equal(rows.length, 3);

  const senko = rows.find((r) => r.name === "Senko");
  assert.equal(senko.role, "support");
  assert.equal(senko.eligible, true);
  assert.equal(senko.deficit, 0);
  assert.equal(senko.alreadyCleared, false);

  const morrah = rows.find((r) => r.name === "Morrah");
  assert.equal(morrah.role, "dps");
  assert.equal(morrah.eligible, true);
  assert.equal(morrah.alreadyCleared, true);

  const low = rows.find((r) => r.name === "Lowblade");
  assert.equal(low.eligible, false);
  assert.equal(low.deficit, 5);
});

test("partitionSelectable drops already-cleared chars (not pointless to re-clear)", () => {
  const rows = [
    { name: "A", alreadyCleared: false },
    { name: "B", alreadyCleared: true },
    { name: "C", alreadyCleared: false },
  ];
  const r = partitionSelectable(rows);
  assert.deepEqual(r.selectable.map((x) => x.name), ["A", "C"]);
  assert.equal(r.allCleared, false);
});

test("partitionSelectable flags allCleared when every eligible char already cleared", () => {
  const r = partitionSelectable([
    { name: "B", alreadyCleared: true },
    { name: "D", alreadyCleared: true },
  ]);
  assert.deepEqual(r.selectable, []);
  assert.equal(r.allCleared, true);
});

test("partitionSelectable: empty input is a no-eligible case, not all-cleared", () => {
  const r = partitionSelectable([]);
  assert.deepEqual(r.selectable, []);
  assert.equal(r.allCleared, false);
});
