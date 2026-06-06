"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeSnapshotPayload,
} = require("../bot/services/local-sync/profile/payload-sanitizer");

test("sanitizeSnapshotPayload applies character profile rules and filters off-roster chars", () => {
  const userDoc = {
    accounts: [
      {
        accountName: "Roster",
        characters: [
          { name: "Aki", class: "Artist", itemLevel: 1750 },
        ],
      },
    ],
  };
  const payload = {
    generatedAt: 1000,
    db: { fileName: "encounters.db", size: 4096, lastModified: 900 },
    accounts: [
      {
        accountName: "Roster",
        characters: [
          {
            name: "Aki",
            role: "support",
            stats: {
              encounters: 12,
              deathRate: 999,
              supportLogCount: 999999,
              avgGearScore: 99999,
              avgPartyBuffedShare: 5000,
              attackStyle: "front",
            },
            scores: { overall: 150, supportUptime: 85 },
            altBuild: { role: "support", encounters: 9, stats: { encounters: 9, avgDps: 12345, deathRate: 999 }, scores: { overall: 150, mvp: 68.4 } },
            topBuffSources: Array.from({ length: 12 }, (_, index) => ({
              id: `buff-${index}`,
              name: `Buff ${index}`,
              category: "classskill",
              target: "PARTY",
              amount: 1000 + index,
              share: 10,
            })),
          },
          {
            name: "NotInRoster",
            stats: { encounters: 99 },
          },
        ],
      },
    ],
  };

  const clean = sanitizeSnapshotPayload(payload, userDoc);
  const account = clean.accounts[0];
  const character = account.characters[0];

  assert.equal(clean.totals.characterCount, 1);
  assert.equal(clean.totals.rejectedCharacters, 1);
  assert.equal(character.name, "Aki");
  assert.equal(character.class, "Artist");
  assert.equal(character.itemLevel, 1750);
  assert.equal(character.stats.deathRate, 100);
  assert.equal(character.stats.supportLogCount, 100000);
  assert.equal(character.stats.avgGearScore, 9999);
  assert.equal(character.stats.avgPartyBuffedShare, 999);
  assert.equal(character.stats.attackStyle, "front");
  assert.equal(character.scores.overall, 100);
  assert.equal(character.scores.supportUptime, 85);
  assert.equal(character.topBuffSources.length, 8);
  // Flex altBuild survives sanitization (local persist path) and its scores clamp.
  assert.equal(character.altBuild.role, "support");
  assert.equal(character.altBuild.encounters, 9);
  assert.equal(character.altBuild.scores.overall, 100);
  assert.equal(character.altBuild.scores.mvp, 68.4);
  // altBuild.stats survives + clamps like the primary stats (alt table needs it).
  assert.equal(character.altBuild.stats.encounters, 9);
  assert.equal(character.altBuild.stats.avgDps, 12345);
  assert.equal(character.altBuild.stats.deathRate, 100);
});
