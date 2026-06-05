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
              avgPeak10sDps: 78000000,
              p90Peak10sDps: 91000000,
              avgBurstRatio: 1.7,
              avgDamageShare: 24.8,
              avgTopDamageProximity: 87.8,
              topRate: 31.2,
              avgDurationMs: 600000,
              avgActiveDurationMs: 570000,
              avgIntermissionMs: 30000,
              avgActiveTimeRate: 95,
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
              avgCritDamageShare: 88.2,
              avgBackAttackRate: 88.2,
              avgFrontAttackRate: 2.1,
              avgBackAttackDamageShare: 91.4,
              avgFrontAttackDamageShare: 0.7,
              avgPositionalDamageShare: 92.1,
              avgHyperShare: 18.5,
              avgSkillCount: 7,
              avgTopSkillShare: 34.1,
              avgDamageTakenPerMinute: 321000,
              avgDamageTakenShare: 13.4,
              avgShieldReceivedPerMinute: 456000,
              lastFightStart: 1710000000000,
              arkPassiveRate: 100,
              buildVariantCount: 2,
              unclassifiedBuildLogCount: 3,
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
            buildVariants: [
              { name: "Wind Fury", encounters: 18, medianDps: 52000000, avgContextPerformancePercentile: 76 },
              { name: "Drizzle", encounters: 6, medianDps: 41000000, avgContextPerformancePercentile: 61 },
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
              avgDurationMs: 500000,
              avgActiveDurationMs: 500000,
              avgIntermissionMs: 0,
              avgActiveTimeRate: 100,
              supporterRankValidCount: 12,
              supporterCompetitiveCount: 8,
              avgSupporterRank: 1.4,
              supporterCountAvg: 2,
              supporterTopRate: 75,
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
              avgCritDamageShare: 6,
              avgBackAttackRate: 0,
              avgFrontAttackRate: 0,
              avgBackAttackDamageShare: 0,
              avgFrontAttackDamageShare: 0,
              avgPositionalDamageShare: 0,
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
              supportRank: 77,
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
  assert.match(character.fields.map((field) => field.value).join("\n"), /Active time: avg \*\*9m 30s\*\* · 95\.0%/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /Damage crit\/pos: \*\*88\.2%\*\* · 92\.1%/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /Damage back\/front: 91\.4% \/ 0\.7%/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /Peak 10s: \*\*78\.0M\*\* - p90 91\.0M - burst x1\.7/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /Unclassified build logs: \*\*3\*\*/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /Variant split: Wind Fury 18 log[\s\S]*Drizzle 6 log/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /Top proximity: \*\*87\.8%\*\*/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /Taken: 321\.0K\/min .* share 13\.4%/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /Shielded: 456\.0K\/min/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /rDPS valid:/);
  assert.match(character.fields.find((field) => field.name === "// SCORE").value, /Context: \*\*N\/A\*\*/);
  assert.match(character.fields.map((field) => field.value).join("\n"), /▰/);

  session.charIndex = 1;
  const support = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  assert.match(support.fields.map((field) => field.value).join("\n"), /Supporter:/);
  assert.match(support.fields.map((field) => field.value).join("\n"), /Radiant 66\.7%/);
  assert.match(support.fields.map((field) => field.value).join("\n"), /Support rank: \*\*1\.4\/2\.0\*\* · top 75\.0%/);
});

test("raid-profile render marks bible summary metrics without local-only fields", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const session = {
    id: "profile-bible-render-test",
    viewerDiscordId: "u1",
    rosterIndex: 0,
    charIndex: 0,
    expiresAt: Date.now() + 60_000,
    entries: [
      {
        ownerDiscordId: "u1",
        ownerLabel: "Traine",
        accessLevel: "owner",
        isOwn: true,
        accountName: "Main",
        generatedAt: 1710000000000,
        receivedAt: 1710000005000,
        source: "bible",
        rangeType: "full",
        characters: [
          {
            name: "Qiylyn",
            class: "Sorceress",
            itemLevel: 1735,
            classRole: "dps",
            role: "dps",
            stats: {
              encounters: 2,
              allEncounterCount: 2,
              avgDps: 120000000,
              medianDps: 120000000,
              p90Dps: 138000000,
              avgRdps: 132000000,
              avgNdps: 101000000,
              avgUdps: 115000000,
              avgDurationMs: 250000,
              avgBiblePercentile: 86,
              avgOverallBiblePercentile: 91,
              biblePercentileCoverageRate: 100,
              deathlessRate: 50,
              deathRate: 50,
              totalDeaths: 1,
              avgDeaths: 0.5,
              busCount: 0,
              busRate: 0,
              lastFightStart: 1710000000000,
              profileDataDepth: "bible-summary",
            },
            scores: {
              overall: 80,
              mvp: 82,
              context: 86,
              survival: 70,
              consistency: 75,
              sourceConfidence: 100,
            },
            build: { spec: "Igniter", gearScore: 1735, combatPower: 123456 },
            topSkills: [],
            buildVariants: [
              { name: "Igniter", encounters: 1, medianDps: 120000000, avgOverallBiblePercentile: 91 },
              { name: "Reflux", encounters: 1, medianDps: 98000000, avgOverallBiblePercentile: 82 },
            ],
            raids: [
              { raidKey: "kazeros", modeKey: "hard", boss: "Abyss Lord Kazeros", encounters: 2, medianDps: 120000000, avgBiblePercentile: 86, deathlessRate: 50 },
            ],
          },
        ],
      },
    ],
  };

  const character = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  const text = character.fields.map((field) => field.value).join("\n");
  assert.match(character.footer.text, /^\/\/ BIBLE FULL/);
  assert.match(character.fields.find((field) => field.name === "// SCORE").value, /Bible pct:/);
  assert.match(text, /Data depth: \*\*lostark\.bible summary\*\*/);
  assert.match(text, /Profile range: \*\*full\*\*/);
  assert.match(text, /Bible pct: \*\*86\.0%\*\* .* overall 91\.0%/);
  assert.match(text, /rDPS\/nDPS: \*\*132\.0M\*\* \/ 101\.0M/);
  assert.match(text, /uDPS: \*\*115\.0M\*\*/);
  assert.match(text, /Variant split: Igniter 1 log[\s\S]*Reflux 1 log/);
  assert.doesNotMatch(text, /Peak 10s:/);
  assert.doesNotMatch(character.fields.map((field) => field.name).join("\n"), /BUFF PROFILE/);
  assert.doesNotMatch(text, /rDPS valid:/);
});

test("raid-profile prefers local detailed snapshot over bible full-lite", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const preferred = command.__test.preferredSnapshotView({
    discordId: "u1",
    source: "local",
    rangeType: "weekly",
    criteria: { source: "encounters.db", range: { type: "weekly" } },
    accounts: [
      {
        accountName: "Main",
        characters: [{ name: "LocalQiylyn", stats: { encounters: 1 } }],
      },
    ],
    rangeSnapshots: {
      full: {
        source: "bible",
        rangeType: "full",
        criteria: { source: "lostark.bible", dataDepth: "bible-summary", range: { type: "full" } },
        accounts: [
          {
            accountName: "Main",
            characters: [{ name: "BibleQiylyn", stats: { encounters: 5 } }],
          },
        ],
      },
    },
  });

  assert.equal(preferred.source, "local");
  assert.equal(preferred.rangeType, "weekly");
  assert.equal(preferred.accounts[0].characters[0].name, "LocalQiylyn");
});

test("raid-profile uses bible full-lite when no richer local snapshot exists", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const preferred = command.__test.preferredSnapshotView({
    discordId: "u1",
    source: "bible",
    rangeType: "weekly",
    criteria: { source: "lostark.bible", dataDepth: "bible-summary", range: { type: "weekly" } },
    accounts: [
      {
        accountName: "Main",
        characters: [{ name: "WeeklyQiylyn", stats: { encounters: 1 } }],
      },
    ],
    rangeSnapshots: {
      full: {
        source: "bible",
        rangeType: "full",
        criteria: { source: "lostark.bible", dataDepth: "bible-summary", range: { type: "full" } },
        accounts: [
          {
            accountName: "Main",
            characters: [{ name: "FullQiylyn", stats: { encounters: 5 } }],
          },
        ],
      },
    },
  });

  assert.equal(preferred.source, "bible");
  assert.equal(preferred.rangeType, "full");
  assert.equal(preferred.accounts[0].characters[0].name, "FullQiylyn");
});

test("raid-profile character dropdown pages to the selected character", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const session = makeSession();
  const roster = session.entries[0];
  for (let i = 0; i < 30; i += 1) {
    roster.characters.push({
      name: `Alt${i}`,
      class: "Aeromancer",
      itemLevel: 1680,
      classRole: "dps",
      role: "dps",
      stats: { encounters: 1 },
      scores: { overall: i + 1, mvp: i },
      build: {},
      topSkills: [],
      raids: [],
    });
  }
  session.rosterIndex = 0;
  session.charIndex = 27;

  const payload = command.__test.renderSessionPayload(deps, session);
  const charMenu = payload.components[1].components[0].toJSON();
  const values = charMenu.options.map((option) => option.value);

  assert.ok(values.includes("27"));
  assert.equal(charMenu.options.find((option) => option.value === "27").default, true);
  assert.equal(values.includes("0"), false);
});

test("raid-profile roster dropdown pages beyond the first 24 rosters", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const session = {
    id: "profile-roster-page-test",
    viewerDiscordId: "u1",
    rosterIndex: -1,
    rosterPage: 1,
    charIndex: -1,
    expiresAt: Date.now() + 60_000,
    entries: Array.from({ length: 30 }, (_, index) => ({
      ownerDiscordId: "u1",
      ownerLabel: "Traine",
      accessLevel: "owner",
      isOwn: index === 0,
      accountName: `Roster${index}`,
      generatedAt: 1710000000000,
      receivedAt: 1710000005000,
      source: "local",
      rangeType: "weekly",
      characters: [
        {
          name: `Char${index}`,
          class: "Aeromancer",
          itemLevel: 1680,
          classRole: "dps",
          role: "dps",
          stats: { encounters: 1, allEncounterCount: 1 },
          scores: { overall: index + 1, mvp: index },
          build: {},
          topSkills: [],
          raids: [],
        },
      ],
    })),
  };

  const payload = command.__test.renderSessionPayload(deps, session);
  const rosterMenu = payload.components[0].components[0].toJSON();
  const values = rosterMenu.options.map((option) => option.value);
  const buttons = payload.components[2].components.map((button) => button.toJSON());

  assert.ok(values.includes("overall"));
  assert.ok(values.includes("24"));
  assert.ok(values.includes("29"));
  assert.equal(values.includes("0"), false);
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[2].disabled, false);
});

test("raid-profile component state reducers handle selects and paging", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const session = makeSession();

  assert.equal(command.__test.applyProfileSelect(session, "roster", "0"), true);
  assert.equal(session.rosterIndex, 0);
  assert.equal(session.rosterPage, 0);
  assert.equal(session.charIndex, -1);

  assert.equal(command.__test.applyProfileSelect(session, "char", "1"), true);
  assert.equal(session.charIndex, 1);
  assert.equal(command.__test.applyProfileButton(session, "overview"), true);
  assert.equal(session.rosterIndex, 0);
  assert.equal(session.charIndex, -1);

  assert.equal(command.__test.applyProfileButton(session, "prev"), true);
  assert.equal(session.charIndex, 1);
  assert.equal(command.__test.applyProfileButton(session, "next"), true);
  assert.equal(session.charIndex, 0);

  assert.equal(command.__test.applyProfileSelect(session, "roster", "missing"), false);
  assert.equal(session.rosterIndex, 0);
  assert.equal(command.__test.applyProfileSelect(session, "roster", "overall"), true);
  assert.equal(session.rosterIndex, -1);
  assert.equal(session.charIndex, -1);
});

test("raid-profile component state reducers page roster lists circularly", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const session = {
    id: "profile-state-page-test",
    viewerDiscordId: "u1",
    rosterIndex: -1,
    rosterPage: 0,
    charIndex: -1,
    expiresAt: Date.now() + 60_000,
    entries: Array.from({ length: 30 }, (_, index) => ({
      accountName: `Roster${index}`,
      isOwn: index === 0,
      characters: [{ name: `Char${index}`, stats: { encounters: 1 }, scores: {} }],
    })),
  };

  assert.equal(command.__test.applyProfileButton(session, "prev"), true);
  assert.equal(session.rosterPage, 1);
  assert.equal(command.__test.applyProfileButton(session, "next"), true);
  assert.equal(session.rosterPage, 0);
  assert.equal(command.__test.applyProfileSelect(session, "roster", "29"), true);
  assert.equal(session.rosterIndex, 29);
  assert.equal(session.rosterPage, 1);
});

test("raid-profile reset wipes only the caller's own snapshot + encounters", async () => {
  const calls = {};
  const deps = {
    ...makeDeps(),
    RaidProfileSnapshot: {
      deleteOne: async (query) => {
        calls.snapshot = query;
        return { deletedCount: 1 };
      },
    },
    RaidProfileEncounter: {
      deleteMany: async (query) => {
        calls.encounter = query;
        return { deletedCount: 42 };
      },
    },
  };
  const command = createRaidProfileCommand(deps);

  let replied;
  const interaction = {
    user: { id: "u1" },
    editReply: async (payload) => {
      replied = payload;
    },
  };
  await command.__test.resetOwnProfile(interaction, "u1", "vi");

  // Both deletes are scoped to the caller's discordId only - never a blanket wipe.
  assert.deepEqual(calls.snapshot, { discordId: "u1" });
  assert.deepEqual(calls.encounter, { discordId: "u1" });
  const embed = replied.embeds[0].toJSON();
  assert.equal(embed.author.name, "// RAID PROFILE · RESET");
  assert.match(embed.description, /42/);
});
