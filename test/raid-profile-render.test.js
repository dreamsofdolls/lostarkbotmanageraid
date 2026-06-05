const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { createRaidProfileCommand } = require("../bot/handlers/raid/profile");
const { UI } = require("../bot/utils/raid/common/shared");

function makeDeps() {
  return {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    UI,
    User: {},
    RaidProfileSnapshot: {},
  };
}

function makeSession() {
  return {
    id: "profile-render-test",
    viewerDiscordId: "u1",
    rosterIndex: -1,
    charIndex: -1,
    expiresAt: Date.now() + 60_000,
    entries: [
      {
        ownerDiscordId: "u1",
        ownerLabel: "Traine",
        accessLevel: "owner",
        isOwn: true,
        accountName: "Clauseduk",
        generatedAt: 1710000000000,
        receivedAt: 1710000005000,
        source: "local",
        characters: [
          {
            name: "Qiylyn",
            class: "Aeromancer",
            itemLevel: 1680,
            classRole: "dps",
            role: "dps",
            stats: {
              encounters: 24,
              allEncounterCount: 24,
              avgDps: 48200000,
              medianDps: 45100000,
              avgDamageShare: 24.8,
              topRate: 31.2,
              deathlessRate: 79.2,
              deathRate: 20.8,
              totalDeaths: 11,
              avgDeaths: 0.5,
              totalDeadTimeMs: 143000,
              avgDeadTimeMs: 5960,
              rdpsValidCount: 18,
              rdpsValidRate: 75,
              avgRank: 2.3,
              avgCritRate: 71.4,
              avgBackAttackRate: 88.2,
              avgFrontAttackRate: 2.1,
              avgHyperShare: 18.5,
              avgSkillCount: 7,
              avgTopSkillShare: 34.1,
              lastFightStart: 1710000000000,
              arkPassiveRate: 100,
              buildVariantCount: 2,
            },
            scores: {
              overall: 68.9,
              mvp: 58.1,
              survival: 71,
              consistency: 66.3,
              damageShare: 74,
            },
            build: {
              spec: "Wind Fury",
              gearScore: 1680,
              combatPower: 2100000,
              arkPassiveActive: true,
              engravings: [{ id: "118", name: "Grudge", level: 3 }],
              arkPassive: {
                evolution: { count: 2, points: 12 },
                enlightenment: {
                  count: 4,
                  points: 8,
                  spec: "Wind Fury",
                  nodes: [
                    { id: 2320000, level: 1, name: "Wind Fury" },
                    { id: 2320100, level: 3, name: "Ventilation" },
                  ],
                },
                leap: { count: 1, points: 6 },
              },
            },
            topSkills: [
              { name: "Doomsday", share: 18.2, critRate: 74.1 },
            ],
            raids: [
              { raidKey: "aegir", modeKey: "hard", boss: "Aegir", encounters: 9, medianDps: 49100000, avgDamageShare: 25.1, topRate: 33 },
            ],
          },
          {
            name: "Canameow",
            class: "Bard",
            itemLevel: 1750,
            classRole: "support",
            role: "support",
            stats: {
              encounters: 12,
              allEncounterCount: 12,
              avgSupporterPercent: 30.4,
              radiantSupportRate: 66.7,
              avgProtectionPerMinute: 9000000,
              avgRdpsDamageGivenPerMinute: 50100000000,
              avgSynergyGivenPerMinute: 123456,
              avgSupportAp: 0.92,
              avgSupportBrand: 0.88,
              avgSupportIdentity: 0.44,
              avgSupportHyper: 0.18,
              deathlessRate: 91.7,
              deathRate: 8.3,
              totalDeaths: 1,
              avgDeaths: 0.08,
              rdpsValidCount: 12,
              rdpsValidRate: 100,
              avgRank: 8,
              avgCritRate: 5,
              avgBackAttackRate: 0,
              avgFrontAttackRate: 0,
              avgHyperShare: 0,
              avgSkillCount: 6,
              avgTopSkillShare: 22,
              lastFightStart: 1710000000000,
            },
            scores: {
              overall: 82.5,
              mvp: 79.2,
              supportUptime: 86.8,
              raidContribution: 84,
              protection: 90,
              survival: 88,
              consistency: 72,
            },
            build: { spec: "Desperate Salvation", arkPassiveActive: true },
            topSkills: [],
            raids: [],
          },
        ],
      },
    ],
  };
}

test("raid-profile render uses Endfield HUD author, gauges, and Enlightenment build line", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const session = makeSession();

  const overall = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  assert.equal(overall.author.name, "// RAID PROFILE · OVERALL");
  assert.ok(overall.fields.some((field) => field.name === "// AGGREGATE SCORE"));
  assert.match(overall.fields.map((field) => field.value).join("\n"), /▰/);
  assert.match(overall.footer.text, /CONF HIGH/);

  session.rosterIndex = 0;
  session.charIndex = 0;
  const character = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  assert.equal(character.author.name, "// RAID PROFILE · CHARACTER");
  assert.ok(character.fields.some((field) => field.name === "// SCORE"));
  assert.ok(character.fields.some((field) => field.name === "// BUILD" && /Enlightenment:/.test(field.value)));
  assert.match(character.fields.map((field) => field.value).join("\n"), /Dead time:/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /rDPS valid:/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /▰/);

  session.charIndex = 1;
  const support = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  assert.match(support.fields.map((field) => field.value).join("\n"), /Supporter:/);
  assert.match(support.fields.map((field) => field.value).join("\n"), /Radiant 66\.7%/);
});
