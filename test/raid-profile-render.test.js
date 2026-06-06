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

test("raid-profile render: HUD author, gauges, #3-rich character tables (DPS + SUP)", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const session = makeSession();

  const overall = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  assert.match(overall.author.name, /^\/\/ RAID PROFILE · OVERALL · \d+ ROSTER · \d+ CHAR$/);
  assert.ok(overall.fields.some((field) => field.name === "// AGGREGATE"));
  assert.match(overall.fields.map((field) => field.value).join("\n"), /▰/);
  // Roster is a fenced code-block table now: aligned CHAR/LOG/SCORE columns,
  // no per-row gauge (it would wrap past the ~42-col embed code-block width).
  const rosterField = overall.fields.find((field) => field.name === "// ROSTER");
  assert.ok(rosterField.value.startsWith("```"));
  assert.match(rosterField.value, /ROSTER NAME\s+CHAR\s+LOG\s+SCORE/);
  assert.ok(!rosterField.value.includes("▰"), "roster table must stay gauge-free to avoid wrap");
  // SCOPE ★ top line prefixes the class icon (custom emoji) or a weapon-emoji fallback.
  const scopeField = overall.fields.find((field) => field.name === "// SCOPE");
  assert.match(scopeField.value, /★ top: (⚔️|🛡️|<:[a-z0-9_]+:\d+>) \*\*/);
  assert.match(overall.footer.text, /CONF HIGH/);

  session.rosterIndex = 0;
  session.charIndex = 0;
  const character = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  assert.equal(character.author.name, "// RAID PROFILE · CHARACTER · QIYLYN · DPS");
  assert.ok(character.fields.some((field) => field.name === "// SCORE"));
  assert.ok(character.fields.some((field) => field.name === "// OUTPUT"));
  assert.ok(character.fields.some((field) => field.name === "// MECHANICS"));
  assert.ok(character.fields.some((field) => field.name === "// SURVIVAL · TANK"));
  assert.ok(character.fields.some((field) => field.name === "// BUILD"));
  const charText = character.fields.map((field) => field.value).join("\n");
  assert.match(charText, /Damage share: \*\*24\.8%\*\*/);
  assert.match(charText, /CPM/);
  assert.match(charText, /Deathless: \*\*79\.2%\*\*/);
  assert.match(charText, /Taken\/min: \*\*321\.0K\*\*/); // tank metric Traine asked for
  assert.match(charText, /Taken share: \*\*13\.4%\*\*/);
  assert.match(charText, /Incap/);
  assert.match(charText, /`Wind Fury`/);
  assert.match(charText, /▰/);

  session.charIndex = 1;
  const support = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  assert.equal(support.author.name, "// RAID PROFILE · CHARACTER · CANAMEOW · SUP");
  assert.ok(support.fields.some((field) => field.name === "// SUPPORT"));
  assert.ok(support.fields.some((field) => field.name === "// UPTIME"));
  assert.ok(support.fields.some((field) => field.name === "// SURVIVAL · TANK"));
  const supText = support.fields.map((field) => field.value).join("\n");
  assert.match(supText, /Supporter%: \*\*30\.4%\*\*/);
  assert.match(supText, /Radiant%: \*\*66\.7%\*\*/);
  assert.match(supText, /Sup rank: \*\*1\.4 \/ 2\.0\*\*/);
  assert.match(supText, /rDPS imp/);
  assert.match(supText, /Synergy/);
});

test("raid-profile renders a flex char: roster flex·SUP tag + two build tables", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const session = {
    id: "profile-flex-test",
    viewerDiscordId: "u1",
    rosterIndex: 0,
    rosterPage: 0,
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
        rangeType: "full",
        characters: [
          {
            // Support class: SUPPORT build is primary, DPS build is the alt.
            name: "Notmeow",
            class: "Artist",
            itemLevel: 1680,
            classRole: "support",
            role: "support",
            stats: {
              encounters: 9,
              allEncounterCount: 56,
              supportLogCount: 9,
              dpsBuildLogCount: 47,
              avgSupporterPercent: 25.4,
              radiantSupportRate: 60,
              deathlessRate: 95,
              avgActiveTimeRate: 96,
            },
            scores: { overall: 71.0, mvp: 68.4, survival: 90, consistency: 75, supportUptime: 70 },
            altBuild: {
              role: "dps",
              encounters: 47,
              stats: {
                encounters: 47,
                avgDamageShare: 8.1,
                avgDps: 15200000,
                deathlessRate: 85,
                avgDamageTakenPerMinute: 280000,
                avgDamageTakenShare: 11,
                avgActiveTimeRate: 93,
              },
              scores: { overall: 24.1, mvp: 20.5, survival: 85, consistency: 60 },
              build: { spec: "Judgment" },
            },
            build: { spec: "Blessed Aura" },
            raids: [],
            topSkills: [],
          },
        ],
      },
    ],
  };

  // Roster list: the flex char is tagged `flex·SUP` (support is primary).
  const roster = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  const charField = roster.fields.find((field) => field.name === "// CHARACTER");
  assert.match(charField.value, /Notmeow/);
  assert.match(charField.value, /flex·SUP/);

  // Character detail: two full build tables. Display primary follows the
  // larger sampled build, so a 47-log DPS build appears above the 9-log SUP.
  session.charIndex = 0;
  const character = command.__test.renderSessionPayload(deps, session).embeds[0].toJSON();
  assert.equal(character.author.name, "// RAID PROFILE · CHARACTER · NOTMEOW · FLEX");
  assert.ok(character.fields.some((field) => field.name === "// PRIMARY · DPS BUILD"));
  assert.ok(character.fields.some((field) => field.name === "// ALT BUILD · SUP BUILD"));
  assert.ok(character.fields.some((field) => field.name === "// SUPPORT"), "support build renders its support table");
  assert.ok(character.fields.some((field) => field.name === "// OUTPUT"), "dps build renders its output table");
  const text = character.fields.map((field) => field.value).join("\n");
  assert.match(text, /Judgment/);
  assert.match(text, /Blessed Aura/);
  assert.match(text, /Supporter%: \*\*25\.4%\*\*/); // support metric from the smaller build
  assert.match(text, /Damage share: \*\*8\.1%\*\*/); // dps metric from altBuild.stats
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
  assert.equal(character.author.name, "// RAID PROFILE · CHARACTER · QIYLYN · DPS");
  assert.ok(character.fields.some((field) => field.name === "// OUTPUT"));
  assert.match(text, /Bible pct: \*\*91\.0%\*\*/);
  assert.match(text, /Avg DPS: \*\*120\.0M\*\*/);
  assert.match(text, /Deathless: \*\*50\.0%\*\*/);
  // bible-summary hides local-only metrics instead of showing N/A noise
  assert.doesNotMatch(text, /Peak 10s:/);
  assert.doesNotMatch(text, /CPM/);
  assert.doesNotMatch(text, /Taken \*\*/);
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

test("raid-profile overview button steps up one level: char -> roster -> overall", () => {
  const deps = makeDeps();
  const command = createRaidProfileCommand(deps);
  const session = makeSession();

  command.__test.applyProfileSelect(session, "roster", "0");
  command.__test.applyProfileSelect(session, "char", "1");
  assert.equal(session.charIndex, 1);

  // character view -> roster view
  assert.equal(command.__test.applyProfileButton(session, "overview"), true);
  assert.equal(session.rosterIndex, 0);
  assert.equal(session.charIndex, -1);

  // roster view -> overall view (previously a silent no-op in this state)
  assert.equal(command.__test.applyProfileButton(session, "overview"), true);
  assert.equal(session.rosterIndex, -1);
  assert.equal(session.charIndex, -1);

  // already overall -> no-op (the button is disabled here in the UI anyway)
  assert.equal(command.__test.applyProfileButton(session, "overview"), false);
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
