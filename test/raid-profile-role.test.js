const test = require("node:test");
const assert = require("node:assert/strict");

test("raid-profile support role detection trusts explicit support and DPS specs before damage fallback", async () => {
  const { classifyProfileLogRole, normalizeProfileSpecKey, roleForProfileClass } = await import("../web/profile-role.js");

  assert.equal(roleForProfileClass("Bard"), "support");
  assert.equal(roleForProfileClass("Aeromancer"), "dps");
  assert.equal(normalizeProfileSpecKey("<b>Desperate&nbsp;Salvation</b>"), "desperatesalvation");

  assert.equal(
    classifyProfileLogRole({
      classRole: "support",
      spec: "Desperate Salvation",
      damageShare: 18.6,
      damageRank: 3,
      partyCount: 8,
    }),
    "support"
  );

  assert.equal(
    classifyProfileLogRole({
      classRole: "support",
      spec: "True Courage",
      damageShare: 1.2,
      damageRank: 8,
      partyCount: 8,
    }),
    "dps"
  );

  assert.equal(
    classifyProfileLogRole({
      classRole: "support",
      spec: "Full Bloom",
      arkPassive: { enlightenment: { spec: "Recurrence" } },
      damageShare: 1.2,
      damageRank: 8,
      partyCount: 8,
    }),
    "dps"
  );

  assert.equal(
    classifyProfileLogRole({
      classRole: "support",
      spec: "True Courage",
      arkPassive: { enlightenment: { spec: "Full Bloom" } },
      damageShare: 18.6,
      damageRank: 3,
      partyCount: 8,
    }),
    "support"
  );

  assert.equal(
    classifyProfileLogRole({
      classRole: "support",
      spec: "",
      damageShare: 18.6,
      damageRank: 3,
      partyCount: 8,
    }),
    "dps"
  );
});
