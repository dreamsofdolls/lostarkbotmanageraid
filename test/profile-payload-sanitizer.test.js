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
              avgSynergyGivenShare: 12.3,
              avgRdpsDamageGivenShare: 34.5,
              attackStyle: "front",
            },
            scores: { overall: 150, supportUptime: 85 },
            altBuild: {
              role: "support",
              encounters: 9,
              stats: { encounters: 9, avgDps: 12345, deathRate: 999 },
              scores: { overall: 150, mvp: 68.4 },
              build: { spec: "Full Bloom", combatPower: 1550000, arkPassiveActive: true },
            },
            topBuffSources: Array.from({ length: 12 }, (_, index) => ({
              id: `buff-${index}`,
              name: `Buff ${index}`,
              category: "classskill",
              target: "PARTY",
              amount: 1000 + index,
              share: 10,
            })),
            raids: [
              {
                raidKey: "aegir",
                modeKey: "hard",
                boss: "Aegir",
                encounters: 3,
                avgSynergyGivenShare: 12.3,
                avgRdpsDamageGivenShare: 34.5,
              },
            ],
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
  assert.equal(character.stats.avgSynergyGivenShare, 12.3);
  assert.equal(character.stats.avgRdpsDamageGivenShare, 34.5);
  assert.equal(character.stats.attackStyle, "front");
  assert.equal(character.scores.overall, 100);
  assert.equal(character.scores.supportUptime, 85);
  assert.equal(character.topBuffSources.length, 8);
  assert.equal(character.raids[0].avgSynergyGivenShare, 12.3);
  assert.equal(character.raids[0].avgRdpsDamageGivenShare, 34.5);
  // Flex altBuild survives sanitization (local persist path) and its scores clamp.
  assert.equal(character.altBuild.role, "support");
  assert.equal(character.altBuild.encounters, 9);
  assert.equal(character.altBuild.scores.overall, 100);
  assert.equal(character.altBuild.scores.mvp, 68.4);
  // altBuild.stats survives + clamps like the primary stats (alt table needs it).
  assert.equal(character.altBuild.stats.encounters, 9);
  assert.equal(character.altBuild.stats.avgDps, 12345);
  assert.equal(character.altBuild.stats.deathRate, 100);
  assert.equal(character.altBuild.build.spec, "Full Bloom");
  assert.equal(character.altBuild.build.combatPower, 1550000);
  assert.equal(character.altBuild.build.arkPassiveActive, true);
});

test("sanitizeSnapshotPayload hydrates missing flex altBuild stats from encounter summaries", () => {
  const userDoc = {
    accounts: [
      {
        accountName: "Roster",
        characters: [
          { name: "Notmeow", class: "Artist", itemLevel: 1740 },
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
            name: "Notmeow",
            classRole: "support",
            role: "dps",
            stats: {
              encounters: 47,
              allEncounterCount: 92,
              supportLogCount: 45,
              dpsBuildLogCount: 47,
            },
            scores: { overall: 24.1 },
            altBuild: {
              role: "support",
              encounters: 45,
              scores: {
                overall: 75.2,
                supportUptime: 83.3,
                raidContribution: 66.3,
              },
            },
          },
        ],
      },
    ],
    encounters: [
      {
        accountName: "Roster",
        characterName: "Notmeow",
        encounterId: "support-1",
        class: "Artist",
        classRole: "support",
        role: "support",
        fightStart: 2000,
        durationMs: 300000,
        boss: "Corvus Tul Rak",
        raidKey: "serca",
        modeKey: "nightmare",
        difficulty: "Nightmare",
        build: { spec: "Full Bloom", combatPower: 2878, arkPassiveActive: true },
        metrics: {
          dps: 7000000,
          rdps: 900000000,
          activeDurationMs: 300000,
          activeTimeRate: 100,
          supportAp: 0.93,
          supportBrand: 0.99,
          supportIdentity: 0.89,
          supportHyper: 0.48,
          supportBuffedShare: 65,
          supportDebuffedShare: 66,
          supporterDamageGivenPerMinute: 55000000000,
          supporterPercent: 49.2,
          supporterRank: 1,
          supporterCount: 2,
          supporterTier: "radiant",
          rdpsValid: true,
          protectionPerMinute: 13000000,
          synergyGivenPerMinute: 55000000000,
          damageTakenPerMinute: 43000,
          damageTakenShare: 30.1,
          incapacitations: 1,
        },
      },
      {
        accountName: "Roster",
        characterName: "Notmeow",
        encounterId: "support-2",
        class: "Artist",
        classRole: "support",
        role: "support",
        fightStart: 2500,
        durationMs: 300000,
        boss: "Witch of Agony, Serca",
        raidKey: "serca",
        modeKey: "nightmare",
        difficulty: "Nightmare",
        build: { spec: "Full Bloom", combatPower: 2900, arkPassiveActive: true },
        metrics: {
          dps: 8000000,
          rdps: 920000000,
          activeDurationMs: 300000,
          activeTimeRate: 100,
          supportAp: 0.95,
          supportBrand: 0.98,
          supportIdentity: 0.91,
          supportHyper: 0.52,
          supporterDamageGivenPerMinute: 57000000000,
          supporterPercent: 45.2,
          supporterRank: 2,
          supporterCount: 2,
          supporterTier: "noble",
          rdpsValid: true,
          protectionPerMinute: 11000000,
          damageTakenPerMinute: 39000,
          damageTakenShare: 24.5,
        },
      },
    ],
  };

  const clean = sanitizeSnapshotPayload(payload, userDoc);
  const character = clean.accounts[0].characters[0];
  const alt = character.altBuild;

  assert.equal(alt.role, "support");
  assert.equal(alt.build.spec, "Full Bloom");
  assert.equal(alt.build.combatPower, 2900);
  assert.equal(alt.stats.encounters, 2);
  assert.equal(alt.stats.avgSupportAp, 0.94);
  assert.equal(alt.stats.avgSupportBrand, 0.99);
  assert.equal(alt.stats.avgSupportIdentity, 0.9);
  assert.equal(alt.stats.avgSupportHyper, 0.5);
  assert.equal(alt.stats.avgSupporterPercent, 47.2);
  assert.equal(alt.stats.radiantSupportRate, 50);
  assert.equal(alt.stats.supporterRankValidCount, 2);
  assert.equal(alt.stats.avgProtectionPerMinute, 12000000);
});
