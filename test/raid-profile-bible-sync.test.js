const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBibleProfileSnapshot,
  buildBibleProfileSnapshotFromEncounterSummaries,
  createBibleProfileSyncService,
  durationToMs,
  roleForLog,
} = require("../bot/services/auto-manage/profile/sync");
const { getRaidGateForBoss, getRaidRequirementMap } = require("../bot/models/Raid");
const { getCharacterName, getCharacterClass } = require("../bot/utils/raid/common/shared");

const RAID_REQUIREMENT_MAP = getRaidRequirementMap();

function entryKey(accountName, charName) {
  return `${String(accountName).trim().toLowerCase()}\x1f${String(charName).trim().toLowerCase()}`;
}

function makeDeps() {
  return {
    getCharacterName,
    getCharacterClass,
    getRaidGateForBoss,
    RAID_REQUIREMENT_MAP,
  };
}

test("bible profile snapshot keeps only supported current-week 3m+ raid logs", () => {
  const userDoc = {
    accounts: [
      {
        accountName: "Main",
        characters: [{ name: "Qiylyn", class: "Sorceress", itemLevel: 1735 }],
      },
    ],
  };

  const built = buildBibleProfileSnapshot({
    discordId: "u1",
    userDoc,
    weekResetStart: 1000,
    deps: makeDeps(),
    collected: [
      {
        accountName: "Main",
        charName: "Qiylyn",
        entryKey: entryKey("Main", "Qiylyn"),
        logs: [
          {
            id: "ok",
            name: "qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            spec: "Igniter",
            gearScore: 1736.5,
            combatPower: 123456,
            dps: 123000000,
            udps: 112000000,
            rdps: 134000000,
            ndps: 98000000,
            percentile: 0.876,
            overallPercentile: 0.9,
            duration: 240,
            timestamp: 2000,
            isDead: false,
          },
          {
            id: "short",
            name: "Qiylyn",
            boss: "Archdemon Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            dps: 1,
            duration: 120,
            timestamp: 2100,
          },
          {
            id: "old",
            name: "Qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            dps: 1,
            duration: 240,
            timestamp: 999,
          },
          {
            id: "guardian",
            name: "Qiylyn",
            boss: "Sonavel",
            difficulty: "Hard",
            class: "Sorceress",
            dps: 1,
            duration: 240,
            timestamp: 2200,
          },
        ],
      },
    ],
    nowMs: 3000,
  });

  assert.ok(built);
  assert.equal(built.snapshot.source, "bible");
  assert.equal(built.snapshot.rangeType, "weekly");
  assert.equal(built.snapshot.totals.encounterCount, 1);
  assert.equal(built.encounterSummaries.length, 1);

  const char = built.snapshot.accounts[0].characters[0];
  assert.equal(char.name, "Qiylyn");
  assert.equal(char.role, "dps");
  assert.equal(char.stats.encounters, 1);
  assert.equal(char.stats.avgDps, 123000000);
  assert.equal(char.stats.avgRdps, 134000000);
  assert.equal(char.stats.avgNdps, 98000000);
  assert.equal(char.stats.avgUdps, 112000000);
  assert.equal(char.stats.avgBiblePercentile, 87.6);
  assert.equal(char.stats.avgOverallBiblePercentile, 90);
  assert.equal(char.stats.deathlessRate, 100);
  assert.equal(char.build.spec, "Igniter");
  assert.equal(char.raids[0].raidKey, "kazeros");
  assert.equal(char.raids[0].modeKey, "hard");
  assert.equal(built.encounterSummaries[0].characterName, "Qiylyn");
  assert.equal(built.encounterSummaries[0].metrics.bibleCharacterName, "qiylyn");
  assert.equal(built.encounterSummaries[0].metrics.biblePercentile, 87.6);
  assert.equal(built.encounterSummaries[0].metrics.overallBiblePercentile, 90);
  assert.equal(built.encounterSummaries[0].metrics.rdps, 134000000);
});

test("bible profile role detection treats support DPS specs as DPS builds", () => {
  assert.equal(roleForLog("Artist", "Full Bloom"), "support");
  assert.equal(roleForLog("Artist", "Recurrence"), "dps");

  const userDoc = {
    accounts: [
      {
        accountName: "Main",
        characters: [{ name: "Paintfox", class: "Artist", itemLevel: 1730 }],
      },
    ],
  };

  const built = buildBibleProfileSnapshot({
    discordId: "u2",
    userDoc,
    weekResetStart: 1000,
    deps: makeDeps(),
    collected: [
      {
        accountName: "Main",
        charName: "Paintfox",
        entryKey: entryKey("Main", "Paintfox"),
        logs: [
          {
            id: "artist-dps",
            name: "Paintfox",
            boss: "Corvus Tul Rak",
            difficulty: "Nightmare",
            class: "Artist",
            spec: "Recurrence",
            gearScore: 1740,
            dps: 98000000,
            percentile: 70,
            duration: 330,
            timestamp: 2000,
            isDead: true,
          },
        ],
      },
    ],
  });

  const char = built.snapshot.accounts[0].characters[0];
  assert.equal(char.classRole, "support");
  assert.equal(char.role, "dps");
  assert.equal(char.stats.dpsBuildLogCount, 1);
  assert.equal(char.stats.supportLogCount, 0);
  assert.equal(char.stats.deathRate, 100);
});

test("bible profile support summaries carry buff uptime from API logs", () => {
  const userDoc = {
    accounts: [
      {
        accountName: "Main",
        characters: [{ name: "Paintfox", class: "Artist", itemLevel: 1730 }],
      },
    ],
  };

  const built = buildBibleProfileSnapshot({
    discordId: "u2a",
    userDoc,
    weekResetStart: 1000,
    deps: makeDeps(),
    collected: [
      {
        accountName: "Main",
        charName: "Paintfox",
        entryKey: entryKey("Main", "Paintfox"),
        logs: [
          {
            id: "artist-support",
            name: "Paintfox",
            boss: "Corvus Tul Rak",
            difficulty: "Nightmare",
            class: "Artist",
            spec: "Full Bloom",
            gearScore: 1740,
            dps: 20000000,
            rdps: 85000000,
            ndps: 15000000,
            percentile: "81.5%",
            overallPercentile: 0.9,
            buffs: [0.92, 0.88, 0.44, 0.18],
            duration: 330,
            timestamp: 2000,
            isDead: false,
          },
        ],
      },
    ],
  });

  const char = built.snapshot.accounts[0].characters[0];
  assert.equal(char.role, "support");
  assert.equal(char.stats.avgBiblePercentile, 81.5);
  assert.equal(char.stats.avgOverallBiblePercentile, 90);
  assert.equal(char.stats.avgSupportAp, 0.92);
  assert.equal(char.stats.avgSupportBrand, 0.88);
  assert.equal(char.stats.avgSupportIdentity, 0.44);
  assert.equal(char.stats.avgSupportHyper, 0.18);
  assert.equal(char.stats.supportBuffCoverageRate, 100);
  assert.equal(char.scores.supportUptime, 67.7);
  assert.equal(built.encounterSummaries[0].metrics.supportAp, 0.92);
  assert.equal(built.encounterSummaries[0].metrics.hasSupportBuffs, true);
});

test("bible profile parses string flags and real death counts", () => {
  const userDoc = {
    accounts: [
      {
        accountName: "Main",
        characters: [{ name: "Qiylyn", class: "Sorceress", itemLevel: 1735 }],
      },
    ],
  };

  const built = buildBibleProfileSnapshot({
    discordId: "u2b",
    userDoc,
    weekResetStart: 1000,
    deps: makeDeps(),
    collected: [
      {
        accountName: "Main",
        charName: "Qiylyn",
        entryKey: entryKey("Main", "Qiylyn"),
        logs: [
          {
            id: "alive-string",
            name: "Qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            dps: 100000000,
            percentile: 80,
            duration: 250,
            timestamp: 2000,
            isDead: "false",
            isBus: "false",
          },
          {
            id: "two-deaths",
            name: "Qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            dps: 90000000,
            percentile: 70,
            duration: 260,
            timestamp: 2100,
            deathCount: 2,
            isBus: "true",
          },
        ],
      },
    ],
  });

  const char = built.snapshot.accounts[0].characters[0];
  assert.equal(char.stats.deathlessRate, 50);
  assert.equal(char.stats.deathRate, 50);
  assert.equal(char.stats.totalDeaths, 2);
  assert.equal(char.stats.avgDeaths, 1);
  assert.equal(char.stats.busCount, 1);
  assert.equal(built.encounterSummaries[0].metrics.isDead, false);
  assert.equal(built.encounterSummaries[1].metrics.deathCount, 2);
});

test("bible profile keeps flexible DPS build variants for the same character", () => {
  const userDoc = {
    accounts: [
      {
        accountName: "Main",
        characters: [{ name: "Qiylyn", class: "Sorceress", itemLevel: 1735 }],
      },
    ],
  };

  const built = buildBibleProfileSnapshot({
    discordId: "u2c",
    userDoc,
    weekResetStart: 1000,
    deps: makeDeps(),
    collected: [
      {
        accountName: "Main",
        charName: "Qiylyn",
        entryKey: entryKey("Main", "Qiylyn"),
        logs: [
          {
            id: "igniter-1",
            name: "Qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            spec: "Igniter",
            dps: 140000000,
            rdps: 150000000,
            ndps: 120000000,
            percentile: 0.92,
            overallPercentile: 0.94,
            duration: 260,
            timestamp: 2000,
          },
          {
            id: "reflux-1",
            name: "Qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            spec: "Reflux",
            dps: 105000000,
            rdps: 110000000,
            ndps: 98000000,
            percentile: 0.81,
            overallPercentile: 0.83,
            duration: 250,
            timestamp: 2100,
          },
        ],
      },
    ],
  });

  const char = built.snapshot.accounts[0].characters[0];
  assert.equal(char.stats.buildVariantCount, 2);
  assert.equal(char.build.spec, "Reflux");
  assert.deepEqual(char.buildVariants.map((variant) => variant.name), ["Reflux", "Igniter"]);
  assert.equal(char.buildVariants[0].encounters, 1);
  assert.equal(char.buildVariants[0].medianDps, 105000000);
  assert.equal(char.buildVariants[1].avgOverallBiblePercentile, 94);
});

test("bible full-lite snapshot accumulates stored encounter summaries across weeks", () => {
  const built = buildBibleProfileSnapshotFromEncounterSummaries({
    summaries: [
      {
        accountName: "Main",
        characterName: "Qiylyn",
        characterNameKey: "qiylyn",
        encounterId: "bible:old",
        class: "Sorceress",
        itemLevel: 1730,
        classRole: "dps",
        role: "dps",
        fightStart: 2000,
        durationMs: 240000,
        boss: "Abyss Lord Kazeros",
        raidKey: "kazeros",
        modeKey: "hard",
        difficulty: "Hard",
        db: { source: "lostark.bible" },
        build: { spec: "Igniter", gearScore: 1730, combatPower: 100000 },
        metrics: { dps: 100000000, biblePercentile: 80, isDead: false, deathCount: 0, dataDepth: "bible-summary" },
      },
      {
        accountName: "Main",
        characterName: "Qiylyn",
        characterNameKey: "qiylyn",
        encounterId: "bible:new",
        class: "Sorceress",
        itemLevel: 1740,
        classRole: "dps",
        role: "dps",
        fightStart: 900000,
        durationMs: 300000,
        boss: "Archdemon Kazeros",
        raidKey: "kazeros",
        modeKey: "hard",
        difficulty: "Hard",
        db: { source: "lostark.bible" },
        build: { spec: "Igniter", gearScore: 1740, combatPower: 120000 },
        metrics: { dps: 140000000, biblePercentile: 92, isDead: true, deathCount: 1, dataDepth: "bible-summary" },
      },
    ],
    nowMs: 1000000,
  });

  assert.ok(built);
  assert.equal(built.snapshot.rangeType, "full");
  assert.equal(built.snapshot.criteria.range.type, "full");
  assert.equal(built.snapshot.criteria.range.minFightStartMs, 2000);
  assert.equal(built.snapshot.totals.encounterCount, 2);
  const char = built.snapshot.accounts[0].characters[0];
  assert.equal(char.stats.encounters, 2);
  assert.equal(char.stats.avgDps, 120000000);
  assert.equal(char.stats.avgBiblePercentile, 86);
  assert.equal(char.stats.deathRate, 50);
});

test("bible full-lite snapshot counts only eligible stored summaries", () => {
  const built = buildBibleProfileSnapshotFromEncounterSummaries({
    summaries: [
      {
        accountName: "Main",
        characterName: "Qiylyn",
        characterNameKey: "qiylyn",
        encounterId: "bible:valid",
        class: "Sorceress",
        itemLevel: 1730,
        classRole: "dps",
        role: "dps",
        fightStart: 2000,
        durationMs: 240000,
        boss: "Abyss Lord Kazeros",
        raidKey: "kazeros",
        modeKey: "hard",
        difficulty: "Hard",
        db: { source: "lostark.bible" },
        build: { spec: "Igniter", gearScore: 1730, combatPower: 100000 },
        metrics: { dps: 100000000, biblePercentile: 80, isDead: false, deathCount: 0, dataDepth: "bible-summary" },
      },
      {
        accountName: "Main",
        characterName: "Qiylyn",
        characterNameKey: "qiylyn",
        encounterId: "bible:short",
        class: "Sorceress",
        itemLevel: 1730,
        classRole: "dps",
        role: "dps",
        fightStart: 2100,
        durationMs: 120000,
        boss: "Abyss Lord Kazeros",
        raidKey: "kazeros",
        modeKey: "hard",
        difficulty: "Hard",
        db: { source: "lostark.bible" },
        build: { spec: "Igniter", gearScore: 1730, combatPower: 100000 },
        metrics: { dps: 100000000, biblePercentile: 80, isDead: false, deathCount: 0, dataDepth: "bible-summary" },
      },
      {
        accountName: "Main",
        characterName: "Qiylyn",
        characterNameKey: "qiylyn",
        encounterId: "local:valid",
        class: "Sorceress",
        itemLevel: 1730,
        classRole: "dps",
        role: "dps",
        fightStart: 2200,
        durationMs: 240000,
        boss: "Abyss Lord Kazeros",
        raidKey: "kazeros",
        modeKey: "hard",
        difficulty: "Hard",
        db: { source: "encounters.db" },
        build: { spec: "Igniter", gearScore: 1730, combatPower: 100000 },
        metrics: { dps: 100000000, biblePercentile: 80, isDead: false, deathCount: 0, dataDepth: "local-full" },
      },
    ],
    nowMs: 1000000,
  });

  assert.ok(built);
  assert.equal(built.snapshot.totals.encounterCount, 1);
  assert.equal(built.snapshot.totals.encounterSummaryCount, 1);
});

test("bible profile sync upserts weekly snapshot and encounter summaries", async () => {
  let updateFilter = null;
  let updateBody = null;
  let bulkOps = null;
  const RaidProfileSnapshot = {
    findOne() {
      return {
        select() {
          return {
            lean: async () => null,
          };
        },
      };
    },
    async findOneAndUpdate(filter, update) {
      updateFilter = filter;
      updateBody = update;
      return {};
    },
  };
  const RaidProfileEncounter = {
    async bulkWrite(ops) {
      bulkOps = ops;
      return { upsertedCount: ops.length, modifiedCount: 0 };
    },
    find() {
      return {
        sort() {
          return {
            lean: async () => [
              {
                accountName: "Main",
                characterName: "Qiylyn",
                characterNameKey: "qiylyn",
                encounterId: "bible:older",
                class: "Sorceress",
                itemLevel: 1730,
                classRole: "dps",
                role: "dps",
                fightStart: 1500,
                durationMs: 240000,
                boss: "Abyss Lord Kazeros",
                raidKey: "kazeros",
                modeKey: "hard",
                difficulty: "Hard",
                db: { source: "lostark.bible" },
                build: { spec: "Igniter", gearScore: 1730, combatPower: 110000 },
                metrics: { dps: 100000000, biblePercentile: 80, isDead: false, deathCount: 0, dataDepth: "bible-summary" },
              },
              {
                accountName: "Main",
                characterName: "Qiylyn",
                characterNameKey: "qiylyn",
                encounterId: "bible:ok",
                class: "Sorceress",
                itemLevel: 1735,
                classRole: "dps",
                role: "dps",
                fightStart: 2000,
                durationMs: 250000,
                boss: "Abyss Lord Kazeros",
                raidKey: "kazeros",
                modeKey: "hard",
                difficulty: "Hard",
                db: { source: "lostark.bible" },
                build: { spec: "", gearScore: 0, combatPower: 0 },
                metrics: { dps: 123000000, biblePercentile: 90, isDead: false, deathCount: 0, dataDepth: "bible-summary" },
              },
              {
                accountName: "OldRoster",
                characterName: "Removedchar",
                characterNameKey: "removedchar",
                encounterId: "bible:removed",
                class: "Sorceress",
                itemLevel: 1735,
                classRole: "dps",
                role: "dps",
                fightStart: 2100,
                durationMs: 250000,
                boss: "Abyss Lord Kazeros",
                raidKey: "kazeros",
                modeKey: "hard",
                difficulty: "Hard",
                db: { source: "lostark.bible" },
                build: { spec: "Igniter", gearScore: 1735, combatPower: 0 },
                metrics: { dps: 999000000, biblePercentile: 99, isDead: false, deathCount: 0, dataDepth: "bible-summary" },
              },
            ],
          };
        },
      };
    },
  };

  const service = createBibleProfileSyncService({
    RaidProfileSnapshot,
    RaidProfileEncounter,
    ...makeDeps(),
    log: { warn: () => {} },
  });

  const result = await service.syncRaidProfileFromBibleCollected({
    discordId: "u3",
    userDoc: {
      accounts: [
        {
          accountName: "Main",
          characters: [{ name: "Qiylyn", class: "Sorceress", itemLevel: 1735 }],
        },
      ],
    },
    weekResetStart: 1000,
    collected: [
      {
        accountName: "Main",
        charName: "Qiylyn",
        entryKey: entryKey("Main", "Qiylyn"),
        logs: [
          {
            id: "ok",
            name: "Qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            dps: 123000000,
            percentile: 90,
            duration: "04:10",
            timestamp: 2000,
          },
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(updateFilter, { discordId: "u3" });
  assert.equal(updateBody.$set.source, "bible");
  assert.equal(updateBody.$set["rangeSnapshots.weekly"].source, "bible");
  assert.equal(updateBody.$set["rangeSnapshots.weekly"].totals.encounterCount, 2);
  assert.equal(updateBody.$set["rangeSnapshots.full"].source, "bible");
  assert.equal(updateBody.$set.rangeType, "full");
  assert.equal(updateBody.$set.totals.encounterCount, 2);
  assert.equal(updateBody.$set.accounts[0].characters.length, 1);
  assert.equal(updateBody.$set.accounts[0].characters[0].name, "Qiylyn");
  assert.equal(bulkOps.length, 1);
  assert.equal(bulkOps[0].updateOne.filter.encounterId, "bible:ok");
  assert.equal(durationToMs("04:10"), 250000);
});

test("bible profile sync preserves an existing local full snapshot as primary", async () => {
  let updateBody = null;
  const RaidProfileSnapshot = {
    findOne() {
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u4",
              source: "local",
              rangeType: "full",
              criteria: { range: { type: "full" } },
              accounts: [{ accountName: "Main", characters: [{ name: "Qiylyn" }] }],
              rangeSnapshots: {},
            }),
          };
        },
      };
    },
    async findOneAndUpdate(_filter, update) {
      updateBody = update;
      return {};
    },
  };
  const RaidProfileEncounter = {
    async bulkWrite(ops) {
      return { upsertedCount: ops.length, modifiedCount: 0 };
    },
    find() {
      return {
        sort() {
          return {
            lean: async () => [
              {
                accountName: "Main",
                characterName: "Qiylyn",
                characterNameKey: "qiylyn",
                encounterId: "bible:ok",
                class: "Sorceress",
                itemLevel: 1735,
                classRole: "dps",
                role: "dps",
                fightStart: 2000,
                durationMs: 250000,
                boss: "Abyss Lord Kazeros",
                raidKey: "kazeros",
                modeKey: "hard",
                difficulty: "Hard",
                db: { source: "lostark.bible" },
                build: { spec: "", gearScore: 0, combatPower: 0 },
                metrics: { dps: 123000000, biblePercentile: 90, isDead: false, deathCount: 0, dataDepth: "bible-summary" },
              },
            ],
          };
        },
      };
    },
  };

  const service = createBibleProfileSyncService({
    RaidProfileSnapshot,
    RaidProfileEncounter,
    ...makeDeps(),
    log: { warn: () => {} },
  });

  const result = await service.syncRaidProfileFromBibleCollected({
    discordId: "u4",
    userDoc: {
      accounts: [
        {
          accountName: "Main",
          characters: [{ name: "Qiylyn", class: "Sorceress", itemLevel: 1735 }],
        },
      ],
    },
    weekResetStart: 1000,
    collected: [
      {
        accountName: "Main",
        charName: "Qiylyn",
        entryKey: entryKey("Main", "Qiylyn"),
        logs: [
          {
            id: "ok",
            name: "Qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            dps: 123000000,
            percentile: 90,
            duration: 250,
            timestamp: 2000,
          },
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.promoted, false);
  assert.equal(updateBody.$set.source, undefined);
  assert.equal(updateBody.$set["rangeSnapshots.full"], undefined);
  assert.equal(updateBody.$set["rangeSnapshots.weekly"].source, "bible");
});

test("bible profile sync can replace an empty local snapshot shell", async () => {
  let updateBody = null;
  const RaidProfileSnapshot = {
    findOne() {
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u4b",
              source: "local",
              rangeType: "full",
              criteria: { source: "encounters.db", range: { type: "full" } },
              accounts: [{ accountName: "Main", characters: [] }],
              rangeSnapshots: {
                full: {
                  source: "local",
                  rangeType: "full",
                  criteria: { source: "encounters.db", range: { type: "full" } },
                  accounts: [{ accountName: "Main", characters: [] }],
                },
              },
            }),
          };
        },
      };
    },
    async findOneAndUpdate(_filter, update) {
      updateBody = update;
      return {};
    },
  };
  const RaidProfileEncounter = {
    async bulkWrite(ops) {
      return { upsertedCount: ops.length, modifiedCount: 0 };
    },
    find() {
      return {
        sort() {
          return {
            lean: async () => [
              {
                accountName: "Main",
                characterName: "Qiylyn",
                characterNameKey: "qiylyn",
                encounterId: "bible:ok",
                class: "Sorceress",
                itemLevel: 1735,
                classRole: "dps",
                role: "dps",
                fightStart: 2000,
                durationMs: 250000,
                boss: "Abyss Lord Kazeros",
                raidKey: "kazeros",
                modeKey: "hard",
                difficulty: "Hard",
                db: { source: "lostark.bible" },
                build: { spec: "Igniter", gearScore: 1735, combatPower: 0 },
                metrics: { dps: 123000000, biblePercentile: 90, isDead: false, deathCount: 0, dataDepth: "bible-summary" },
              },
            ],
          };
        },
      };
    },
  };

  const service = createBibleProfileSyncService({
    RaidProfileSnapshot,
    RaidProfileEncounter,
    ...makeDeps(),
    log: { warn: () => {} },
  });

  const result = await service.syncRaidProfileFromBibleCollected({
    discordId: "u4b",
    userDoc: {
      accounts: [
        {
          accountName: "Main",
          characters: [{ name: "Qiylyn", class: "Sorceress", itemLevel: 1735 }],
        },
      ],
    },
    weekResetStart: 1000,
    collected: [
      {
        accountName: "Main",
        charName: "Qiylyn",
        entryKey: entryKey("Main", "Qiylyn"),
        logs: [
          {
            id: "ok",
            name: "Qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            spec: "Igniter",
            dps: 123000000,
            percentile: 0.9,
            duration: 250,
            timestamp: 2000,
          },
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.promoted, true);
  assert.equal(updateBody.$set.source, "bible");
  assert.equal(updateBody.$set.rangeType, "full");
  assert.equal(updateBody.$set["rangeSnapshots.full"].source, "bible");
  assert.equal(updateBody.$set.accounts[0].characters[0].name, "Qiylyn");
});

test("bible profile sync does not overwrite an existing local weekly snapshot", async () => {
  let updateBody = null;
  const localWeekly = {
    source: "local",
    rangeType: "weekly",
    criteria: { source: "encounters.db", range: { type: "weekly" } },
    accounts: [{ accountName: "Main", characters: [{ name: "Qiylyn" }] }],
  };
  const RaidProfileSnapshot = {
    findOne() {
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u5",
              ...localWeekly,
              rangeSnapshots: { weekly: localWeekly },
            }),
          };
        },
      };
    },
    async findOneAndUpdate(_filter, update) {
      updateBody = update;
      return {};
    },
  };
  const RaidProfileEncounter = {
    async bulkWrite(ops) {
      return { upsertedCount: ops.length, modifiedCount: 0 };
    },
    find() {
      return {
        sort() {
          return {
            lean: async () => [
              {
                accountName: "Main",
                characterName: "Qiylyn",
                characterNameKey: "qiylyn",
                encounterId: "bible:ok",
                class: "Sorceress",
                itemLevel: 1735,
                classRole: "dps",
                role: "dps",
                fightStart: 2000,
                durationMs: 250000,
                boss: "Abyss Lord Kazeros",
                raidKey: "kazeros",
                modeKey: "hard",
                difficulty: "Hard",
                db: { source: "lostark.bible" },
                build: { spec: "", gearScore: 0, combatPower: 0 },
                metrics: { dps: 123000000, biblePercentile: 90, isDead: false, deathCount: 0, dataDepth: "bible-summary" },
              },
            ],
          };
        },
      };
    },
  };

  const service = createBibleProfileSyncService({
    RaidProfileSnapshot,
    RaidProfileEncounter,
    ...makeDeps(),
    log: { warn: () => {} },
  });

  const result = await service.syncRaidProfileFromBibleCollected({
    discordId: "u5",
    userDoc: {
      accounts: [
        {
          accountName: "Main",
          characters: [{ name: "Qiylyn", class: "Sorceress", itemLevel: 1735 }],
        },
      ],
    },
    weekResetStart: 1000,
    collected: [
      {
        accountName: "Main",
        charName: "Qiylyn",
        entryKey: entryKey("Main", "Qiylyn"),
        logs: [
          {
            id: "ok",
            name: "Qiylyn",
            boss: "Abyss Lord Kazeros",
            difficulty: "Hard",
            class: "Sorceress",
            dps: 123000000,
            percentile: 90,
            duration: 250,
            timestamp: 2000,
          },
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.promoted, false);
  assert.equal(updateBody.$set.source, undefined);
  assert.equal(updateBody.$set["rangeSnapshots.weekly"], undefined);
  assert.equal(updateBody.$set["rangeSnapshots.full"].source, "bible");
});
