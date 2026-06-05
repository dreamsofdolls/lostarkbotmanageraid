process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const { PassThrough } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

const { mintToken } = require("../bot/services/local-sync");
const { hashProfileDeviceToken } = require("../bot/services/local-sync/profile-device-token");
const {
  createProfileSessionEndpoint,
  createRaidProfileSyncEndpoint,
  MAX_BODY_BYTES,
} = require("../bot/services/local-sync/profile-sync-endpoint");

function makeReq({ token, method = "POST", body = null } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  process.nextTick(() => {
    if (body === null) req.end();
    else req.end(JSON.stringify(body));
  });
  return req;
}

function makeRes() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body || "";
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    },
  };
}

test("profile-session endpoint mints a device token from a current local-sync token", async () => {
  const localToken = mintToken("u1");
  const updateCalls = [];
  const User = {
    findOne() {
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              localSyncEnabled: true,
              lastLocalSyncToken: localToken,
              lastLocalSyncTokenExpAt: 9999999999,
            }),
          };
        },
      };
    },
    async findOneAndUpdate(filter, update) {
      updateCalls.push({ filter, update });
      return { discordId: "u1" };
    },
  };
  const handler = createProfileSessionEndpoint({ User });
  const res = makeRes();

  await handler(makeReq({ token: localToken }), res, { query: {} });

  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.profileToken, "string");
  assert.ok(body.profileToken.length > 20);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].filter, { discordId: "u1", localSyncEnabled: true });
  assert.equal(
    updateCalls[0].update.$set.localProfileSyncTokenHash,
    hashProfileDeviceToken(body.profileToken)
  );
  assert.equal(body.expSec, updateCalls[0].update.$set.localProfileSyncTokenExpAt);
});

test("raid-profile-sync endpoint stores only registered roster characters", async () => {
  const profileToken = "profile-device-token";
  const tokenHash = hashProfileDeviceToken(profileToken);
  const savedSnapshots = [];
  const savedEncounterWrites = [];
  const userUpdates = [];
  const User = {
    findOne(query) {
      assert.deepEqual(query, { localProfileSyncTokenHash: tokenHash });
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              localSyncEnabled: true,
              localProfileSyncTokenHash: tokenHash,
              localProfileSyncTokenExpAt: 9999999999,
              accounts: [
                {
                  accountName: "Roster",
                  characters: [
                    { name: "Aki", class: "Artist", itemLevel: 1750 },
                  ],
                },
              ],
            }),
          };
        },
      };
    },
    async updateOne(filter, update) {
      userUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    },
  };
  const RaidProfileSnapshot = {
    async findOneAndUpdate(filter, update, options) {
      savedSnapshots.push({ filter, update, options });
      return { discordId: filter.discordId };
    },
  };
  const RaidProfileEncounter = {
    async bulkWrite(ops, options) {
      savedEncounterWrites.push({ ops, options });
      return { upsertedCount: ops.length, modifiedCount: 0 };
    },
  };
  const handler = createRaidProfileSyncEndpoint({ User, RaidProfileSnapshot, RaidProfileEncounter });
  const res = makeRes();

  await handler(
    makeReq({
      token: profileToken,
      body: {
        generatedAt: 1000,
        db: { fileName: "encounters.db", size: 4096, lastModified: 999 },
        criteria: { modernProfileStatsOnly: true },
        accounts: [
          {
            accountName: "Roster",
            characters: [
              {
                name: "Aki",
                class: "Wrong Client Class",
                role: "dps",
                stats: {
                  encounters: 12,
                  allEncounterCount: 20,
                  supportLogCount: 8,
                  dpsBuildLogCount: 12,
                  supportLogRate: 40,
                  dpsBuildLogRate: 60,
                  primaryRoleRate: 60,
                  avgDurationMs: 500000,
                  avgActiveDurationMs: 470000,
                  avgIntermissionMs: 30000,
                  avgActiveTimeRate: 94,
                  avgDps: 123,
                  avgPeak10sDps: 456,
                  p90Peak10sDps: 789,
                  avgBurstRatio: 1.7,
                  avgTopDamageProximity: 87.8,
                  contextCoverageRate: 83.3,
                  contextSampleCountAvg: 42.5,
                  avgContextPerformancePercentile: 76.4,
                  avgContextDamageSharePercentile: 74.2,
                  avgContextTopDamageProximityPercentile: 79.1,
                  avgContextSupportPercentile: 68.5,
                  lastFightStart: 3000,
                  deathlessRate: 75,
                  deathRate: 25,
                  totalDeaths: 3,
                  avgDeaths: 0.25,
                  totalDeadTimeMs: 42000,
                  avgDeadTimeMs: 3500,
                  avgDeadTimeRate: 1.4,
                  rdpsValidCount: 9,
                  rdpsValidRate: 75,
                  avgSupporterPercent: 30.4,
                  medianSupporterPercent: 29.1,
                  radiantSupportCount: 6,
                  radiantSupportRate: 50,
                  avgSupporterDamageGivenPerMinute: 50100000000,
                  supporterRankValidCount: 9,
                  supporterCompetitiveCount: 7,
                  avgSupporterRank: 1.4,
                  supporterCountAvg: 2,
                  supporterTopRate: 71.4,
                  avgCritRate: 82.5,
                  avgCritDamageShare: 91.2,
                  avgBackAttackRate: 48,
                  avgFrontAttackRate: 3,
                  avgBackAttackDamageShare: 54.3,
                  avgFrontAttackDamageShare: 4.4,
                  avgPositionalDamageShare: 58.7,
                  attackStyle: "back",
                  avgStaggerPerMinute: 1600,
                  avgDamageTakenPerMinute: 45000,
                  damageTakenShareValidCount: 12,
                  avgDamageTakenShare: 13.4,
                  avgShieldReceivedPerMinute: 900000,
                  avgIncapacitations: 0.5,
                  avgSynergyGivenPerMinute: 12345,
                  avgProtection: 123456,
                  avgProtectionPerMinute: 456789,
                  avgPartyBuffedShare: 133.7,
                  avgSelfBuffedShare: 25.5,
                  avgPartyDebuffedShare: 101.2,
                  avgBattleItemDebuffedShare: 8.8,
                  avgGearScore: 1750,
                  latestGearScore: 1755,
                  avgCombatPower: 1234.5,
                  latestCombatPower: 1300.25,
                  arkPassiveRate: 50,
                  buildVariantCount: 2,
                  unclassifiedBuildLogCount: 3,
                },
                scores: { overall: 88.8, mvp: 77.7, context: 76.4, supportRank: 72.3, protection: 45.6 },
                build: {
                  classId: 314,
                  spec: "Full Bloom",
                  gearScore: 1755,
                  combatPower: 1300.25,
                  arkPassiveActive: true,
                  engravings: [
                    { id: "118", name: "Grudge", level: 3, isClass: false },
                    { id: "315", name: "Full Bloom", level: 3, isClass: true },
                  ],
                  arkPassive: {
                    evolution: { count: 2, points: 40 },
                    enlightenment: {
                      count: 1,
                      points: 3,
                      spentPoints: 24,
                      spec: "Full Bloom",
                      nodes: [
                        {
                          id: 2310000,
                          level: 1,
                          name: "Setting Moon",
                          tier: 1,
                          position: 1,
                          maxLevel: 1,
                          points: 24,
                        },
                      ],
                    },
                    leap: { count: 1, points: 5 },
                  },
                },
                topSkills: [
                  {
                    id: "123",
                    name: "Main Skill",
                    damage: 987654321,
                    share: 42.5,
                    casts: 12,
                    hits: 34,
                    critRate: 80,
                    backAttackRate: 50,
                    frontAttackRate: 0,
                    stagger: 1234,
                  },
                ],
                buildVariants: [
                  {
                    name: "Igniter",
                    spec: "Igniter",
                    role: "dps",
                    encounters: 7,
                    avgDps: 120000000,
                    medianDps: 118000000,
                    avgContextPerformancePercentile: 81.5,
                  },
                  {
                    name: "Reflux",
                    spec: "Reflux",
                    role: "dps",
                    encounters: 5,
                    avgDps: 98000000,
                    medianDps: 95000000,
                    avgContextPerformancePercentile: 72.1,
                  },
                ],
                topBuffSources: [
                  { id: "361501", name: "God's Decree", category: "classskill", target: "PARTY", amount: 999, share: 133.7 },
                ],
                topDebuffSources: [
                  { id: "32251", name: "Dark Grenade", category: "battleitem", target: "PARTY", amount: 123, share: 8.8 },
                ],
                topShieldGivenSources: [
                  { id: "25500", name: "Pet Protection", category: "pet", target: "OTHER", amount: 456, share: 12.3 },
                ],
                topShieldReceivedSources: [
                  { id: "361411", name: "Vow of Light", category: "classskill", target: "PARTY", amount: 789, share: 45.6 },
                ],
                raids: [
                  {
                    raidKey: "kazeros",
                    modeKey: "normal",
                    boss: "Abyss Lord Kazeros",
                    encounters: 4,
                    avgDps: 123,
                    avgPeak10sDps: 456,
                    p90Peak10sDps: 789,
                    avgBurstRatio: 1.7,
                    avgDamageShare: 12.3,
                    avgTopDamageProximity: 87.8,
                    contextCoverageRate: 75,
                    contextSampleCountAvg: 34,
                    avgContextPerformancePercentile: 66.6,
                    avgContextDamageSharePercentile: 65.5,
                    avgContextTopDamageProximityPercentile: 67.7,
                    avgContextSupportPercentile: 0,
                  },
                ],
              },
              {
                name: "OffRoster",
                stats: { encounters: 99 },
                scores: { overall: 100 },
              },
            ],
          },
        ],
        encounters: [
          {
            encounterId: "enc-1",
            accountName: "Roster",
            characterName: "Aki",
            class: "Wrong Client Class",
            role: "dps",
            fightStart: 3000,
            durationMs: 420000,
            boss: "Abyss Lord Kazeros",
            raidKey: "kazeros",
            modeKey: "normal",
            difficulty: "Normal",
            build: {
              classId: 314,
              spec: "Full Bloom",
              gearScore: 1755,
              combatPower: 1300.25,
              arkPassiveActive: true,
              engravings: [{ id: "315", name: "Full Bloom", level: 3, isClass: true }],
              arkPassive: {
                evolution: { count: 2, points: 40, spentPoints: 40 },
                enlightenment: { count: 1, points: 3, spentPoints: 24, spec: "Full Bloom" },
                leap: { count: 1, points: 5, spentPoints: 5 },
              },
            },
            metrics: {
              dps: 123,
              rdps: 456,
              peak10sDps: 789,
              burstRatio: 1.8,
              rdpsValid: true,
              activeDurationMs: 390000,
              intermissionMs: 30000,
              activeTimeRate: 92.9,
              damageShare: 12.3,
              topDamageProximity: 87.8,
              contextSampleCount: 42,
              contextSource: "spec",
              contextPerformancePercentile: 76.4,
              contextDamageSharePercentile: 74.2,
              contextTopDamageProximityPercentile: 79.1,
              contextSupportPercentile: 68.5,
              damageTakenShare: 13.4,
              critDamageShare: 91.2,
              backAttackDamageShare: 54.3,
              frontAttackDamageShare: 4.4,
              positionalDamageShare: 58.7,
              deathCount: 1,
              deadTimeMs: 42000,
              deadTimeRate: 10,
              rdpsDamageGivenPerMinute: 987654,
              supporterDamageGiven: 123456789,
              supporterDamageGivenPerMinute: 50100000000,
              supporterPercent: 30.4,
              supporterTier: "radiant",
              supporterRank: 1,
              supporterCount: 2,
            },
            topSkills: [{ id: "123", name: "Main Skill", damage: 987, share: 42.5 }],
          },
          {
            encounterId: "enc-off",
            accountName: "Roster",
            characterName: "OffRoster",
            fightStart: 3001,
            boss: "Abyss Lord Kazeros",
            raidKey: "kazeros",
            modeKey: "normal",
          },
        ],
      },
    }),
    res,
    { query: {} }
  );

  assert.equal(res.status, 200);
  assert.equal(res.json().totals.characterCount, 1);
  assert.equal(res.json().totals.rejectedCharacters, 1);
  assert.equal(savedSnapshots.length, 1);
  assert.deepEqual(savedSnapshots[0].filter, { discordId: "u1" });
  const saved = savedSnapshots[0].update.$set;
  assert.equal(saved.accounts.length, 1);
  assert.equal(saved.accounts[0].characters.length, 1);
  assert.equal(saved.accounts[0].characters[0].name, "Aki");
  assert.equal(saved.accounts[0].characters[0].class, "Artist");
  assert.equal(saved.accounts[0].characters[0].classRole, "support");
  assert.equal(saved.accounts[0].characters[0].role, "dps");
  assert.equal(saved.accounts[0].characters[0].stats.encounters, 12);
  assert.equal(saved.accounts[0].characters[0].stats.allEncounterCount, 20);
  assert.equal(saved.accounts[0].characters[0].stats.supportLogCount, 8);
  assert.equal(saved.accounts[0].characters[0].stats.dpsBuildLogCount, 12);
  assert.equal(saved.accounts[0].characters[0].stats.primaryRoleRate, 60);
  assert.equal(saved.accounts[0].characters[0].stats.avgDurationMs, 500000);
  assert.equal(saved.accounts[0].characters[0].stats.avgActiveDurationMs, 470000);
  assert.equal(saved.accounts[0].characters[0].stats.avgIntermissionMs, 30000);
  assert.equal(saved.accounts[0].characters[0].stats.avgActiveTimeRate, 94);
  assert.equal(saved.accounts[0].characters[0].stats.avgPeak10sDps, 456);
  assert.equal(saved.accounts[0].characters[0].stats.p90Peak10sDps, 789);
  assert.equal(saved.accounts[0].characters[0].stats.avgBurstRatio, 1.7);
  assert.equal(saved.accounts[0].characters[0].stats.totalDeaths, 3);
  assert.equal(saved.accounts[0].characters[0].stats.avgDeaths, 0.25);
  assert.equal(saved.accounts[0].characters[0].stats.deathRate, 25);
  assert.equal(saved.accounts[0].characters[0].stats.totalDeadTimeMs, 42000);
  assert.equal(saved.accounts[0].characters[0].stats.avgDeadTimeMs, 3500);
  assert.equal(saved.accounts[0].characters[0].stats.avgDeadTimeRate, 1.4);
  assert.equal(saved.accounts[0].characters[0].stats.rdpsValidCount, 9);
  assert.equal(saved.accounts[0].characters[0].stats.rdpsValidRate, 75);
  assert.equal(saved.accounts[0].characters[0].stats.avgSupporterPercent, 30.4);
  assert.equal(saved.accounts[0].characters[0].stats.medianSupporterPercent, 29.1);
  assert.equal(saved.accounts[0].characters[0].stats.radiantSupportCount, 6);
  assert.equal(saved.accounts[0].characters[0].stats.radiantSupportRate, 50);
  assert.equal(saved.accounts[0].characters[0].stats.avgSupporterDamageGivenPerMinute, 50100000000);
  assert.equal(saved.accounts[0].characters[0].stats.supporterRankValidCount, 9);
  assert.equal(saved.accounts[0].characters[0].stats.supporterCompetitiveCount, 7);
  assert.equal(saved.accounts[0].characters[0].stats.avgSupporterRank, 1.4);
  assert.equal(saved.accounts[0].characters[0].stats.supporterCountAvg, 2);
  assert.equal(saved.accounts[0].characters[0].stats.supporterTopRate, 71.4);
  assert.equal(saved.accounts[0].characters[0].stats.attackStyle, "back");
  assert.equal(saved.accounts[0].characters[0].stats.avgTopDamageProximity, 87.8);
  assert.equal(saved.accounts[0].characters[0].stats.contextCoverageRate, 83.3);
  assert.equal(saved.accounts[0].characters[0].stats.contextSampleCountAvg, 42.5);
  assert.equal(saved.accounts[0].characters[0].stats.avgContextPerformancePercentile, 76.4);
  assert.equal(saved.accounts[0].characters[0].stats.avgContextDamageSharePercentile, 74.2);
  assert.equal(saved.accounts[0].characters[0].stats.avgContextTopDamageProximityPercentile, 79.1);
  assert.equal(saved.accounts[0].characters[0].stats.avgContextSupportPercentile, 68.5);
  assert.equal(saved.accounts[0].characters[0].stats.avgCritRate, 82.5);
  assert.equal(saved.accounts[0].characters[0].stats.avgCritDamageShare, 91.2);
  assert.equal(saved.accounts[0].characters[0].stats.avgBackAttackDamageShare, 54.3);
  assert.equal(saved.accounts[0].characters[0].stats.avgFrontAttackDamageShare, 4.4);
  assert.equal(saved.accounts[0].characters[0].stats.avgPositionalDamageShare, 58.7);
  assert.equal(saved.accounts[0].characters[0].stats.damageTakenShareValidCount, 12);
  assert.equal(saved.accounts[0].characters[0].stats.avgDamageTakenShare, 13.4);
  assert.equal(saved.accounts[0].characters[0].stats.avgSynergyGivenPerMinute, 12345);
  assert.equal(saved.accounts[0].characters[0].stats.avgProtectionPerMinute, 456789);
  assert.equal(saved.accounts[0].characters[0].stats.avgPartyBuffedShare, 133.7);
  assert.equal(saved.accounts[0].characters[0].stats.avgPartyDebuffedShare, 101.2);
  assert.equal(saved.accounts[0].characters[0].stats.latestGearScore, 1755);
  assert.equal(saved.accounts[0].characters[0].stats.arkPassiveRate, 50);
  assert.equal(saved.accounts[0].characters[0].stats.buildVariantCount, 2);
  assert.equal(saved.accounts[0].characters[0].stats.unclassifiedBuildLogCount, 3);
  assert.equal(saved.accounts[0].characters[0].scores.context, 76.4);
  assert.equal(saved.accounts[0].characters[0].scores.supportRank, 72.3);
  assert.equal(saved.accounts[0].characters[0].scores.protection, 45.6);
  assert.equal(saved.accounts[0].characters[0].build.spec, "Full Bloom");
  assert.equal(saved.accounts[0].characters[0].build.engravings.length, 2);
  assert.equal(saved.accounts[0].characters[0].build.arkPassive.evolution.points, 40);
  assert.equal(saved.accounts[0].characters[0].build.arkPassive.enlightenment.spec, "Full Bloom");
  assert.equal(saved.accounts[0].characters[0].raids[0].contextCoverageRate, 75);
  assert.equal(saved.accounts[0].characters[0].raids[0].contextSampleCountAvg, 34);
  assert.equal(saved.accounts[0].characters[0].raids[0].avgContextPerformancePercentile, 66.6);
  assert.equal(saved.accounts[0].characters[0].raids[0].avgContextDamageSharePercentile, 65.5);
  assert.equal(saved.accounts[0].characters[0].raids[0].avgContextTopDamageProximityPercentile, 67.7);
  assert.equal(saved.accounts[0].characters[0].raids[0].avgPeak10sDps, 456);
  assert.equal(saved.accounts[0].characters[0].raids[0].p90Peak10sDps, 789);
  assert.equal(saved.accounts[0].characters[0].raids[0].avgBurstRatio, 1.7);
  assert.equal(saved.accounts[0].characters[0].build.arkPassive.enlightenment.spentPoints, 24);
  assert.equal(saved.accounts[0].characters[0].build.arkPassive.enlightenment.nodes[0].name, "Setting Moon");
  assert.equal(saved.accounts[0].characters[0].topSkills.length, 1);
  assert.equal(saved.accounts[0].characters[0].topSkills[0].name, "Main Skill");
  assert.equal(saved.accounts[0].characters[0].topSkills[0].share, 42.5);
  assert.equal(saved.accounts[0].characters[0].buildVariants.length, 2);
  assert.equal(saved.accounts[0].characters[0].buildVariants[0].name, "Igniter");
  assert.equal(saved.accounts[0].characters[0].buildVariants[1].medianDps, 95000000);
  assert.equal(saved.accounts[0].characters[0].topBuffSources[0].name, "God's Decree");
  assert.equal(saved.accounts[0].characters[0].topDebuffSources[0].category, "battleitem");
  assert.equal(saved.accounts[0].characters[0].topShieldGivenSources[0].target, "OTHER");
  assert.equal(saved.accounts[0].characters[0].topShieldReceivedSources[0].share, 45.6);
  assert.equal(saved.rangeType, "full");
  assert.equal(saved.criteria.modernProfileStatsOnly, true);
  assert.equal(saved.criteria.range.type, "full");
  assert.equal(saved["rangeSnapshots.full"].criteria.range.type, "full");
  assert.equal(saved["rangeSnapshots.full"].encounterSummaries, undefined);
  assert.equal(saved.totals.encounterCount, 12);
  assert.equal(saved.totals.encounterSummaryCount, 1);
  assert.equal(savedEncounterWrites.length, 1);
  assert.equal(savedEncounterWrites[0].ops.length, 1);
  assert.equal(savedEncounterWrites[0].options.ordered, false);
  const encounterOp = savedEncounterWrites[0].ops[0].updateOne;
  assert.deepEqual(encounterOp.filter, {
    discordId: "u1",
    encounterId: "enc-1",
    characterNameKey: "aki",
  });
  assert.equal(encounterOp.update.$set.accountName, "Roster");
  assert.equal(encounterOp.update.$set.characterName, "Aki");
  assert.equal(encounterOp.update.$set.class, "Artist");
  assert.equal(encounterOp.update.$set.role, "dps");
  assert.equal(encounterOp.update.$set.rangeType, "full");
  assert.equal(encounterOp.update.$setOnInsert, undefined);
  assert.equal(encounterOp.update.$set.metrics.rdpsValid, true);
  assert.equal(encounterOp.update.$set.metrics.peak10sDps, 789);
  assert.equal(encounterOp.update.$set.metrics.burstRatio, 1.8);
  assert.equal(encounterOp.update.$set.metrics.activeDurationMs, 390000);
  assert.equal(encounterOp.update.$set.metrics.intermissionMs, 30000);
  assert.equal(encounterOp.update.$set.metrics.activeTimeRate, 92.9);
  assert.equal(encounterOp.update.$set.metrics.topDamageProximity, 87.8);
  assert.equal(encounterOp.update.$set.metrics.contextSampleCount, 42);
  assert.equal(encounterOp.update.$set.metrics.contextSource, "spec");
  assert.equal(encounterOp.update.$set.metrics.contextPerformancePercentile, 76.4);
  assert.equal(encounterOp.update.$set.metrics.contextDamageSharePercentile, 74.2);
  assert.equal(encounterOp.update.$set.metrics.contextTopDamageProximityPercentile, 79.1);
  assert.equal(encounterOp.update.$set.metrics.contextSupportPercentile, 68.5);
  assert.equal(encounterOp.update.$set.metrics.damageTakenShare, 13.4);
  assert.equal(encounterOp.update.$set.metrics.critDamageShare, 91.2);
  assert.equal(encounterOp.update.$set.metrics.backAttackDamageShare, 54.3);
  assert.equal(encounterOp.update.$set.metrics.frontAttackDamageShare, 4.4);
  assert.equal(encounterOp.update.$set.metrics.positionalDamageShare, 58.7);
  assert.equal(encounterOp.update.$set.metrics.deadTimeMs, 42000);
  assert.equal(encounterOp.update.$set.metrics.supporterPercent, 30.4);
  assert.equal(encounterOp.update.$set.metrics.supporterTier, "radiant");
  assert.equal(encounterOp.update.$set.metrics.supporterRank, 1);
  assert.equal(encounterOp.update.$set.metrics.supporterCount, 2);
  assert.equal(encounterOp.update.$set.topSkills[0].name, "Main Skill");
  assert.equal(userUpdates.length, 1);
  assert.deepEqual(userUpdates[0].filter, {
    discordId: "u1",
    localProfileSyncTokenHash: tokenHash,
  });
  assert.equal(typeof userUpdates[0].update.$set.lastLocalProfileSyncAt, "number");
});

test("raid-profile-sync endpoint ignores empty profile snapshots without writing shells", async () => {
  const profileToken = "profile-device-token-empty";
  const tokenHash = hashProfileDeviceToken(profileToken);
  const User = {
    findOne(query) {
      assert.deepEqual(query, { localProfileSyncTokenHash: tokenHash });
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u-empty",
              localSyncEnabled: true,
              localProfileSyncTokenHash: tokenHash,
              localProfileSyncTokenExpAt: 9999999999,
              accounts: [
                {
                  accountName: "Roster",
                  characters: [{ name: "Aki", class: "Artist", itemLevel: 1750 }],
                },
              ],
            }),
          };
        },
      };
    },
    async updateOne() {
      throw new Error("empty profile must not update user metadata");
    },
  };
  const RaidProfileSnapshot = {
    async findOne() {
      throw new Error("empty profile must not read existing snapshots");
    },
    async findOneAndUpdate() {
      throw new Error("empty profile must not write snapshot shells");
    },
  };
  const RaidProfileEncounter = {
    async bulkWrite() {
      throw new Error("empty profile must not write encounters");
    },
  };
  const handler = createRaidProfileSyncEndpoint({ User, RaidProfileSnapshot, RaidProfileEncounter });
  const res = makeRes();

  await handler(
    makeReq({
      token: profileToken,
      body: {
        generatedAt: 1000,
        criteria: { modernProfileStatsOnly: true, range: { type: "full" } },
        accounts: [],
        encounters: [],
      },
    }),
    res,
    { query: {} }
  );

  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.skipped, "empty-profile");
  assert.equal(body.discordId, "u-empty");
  assert.equal(body.totals.characterCount, 0);
  assert.equal(body.totals.encounterCount, 0);
});

test("raid-profile-sync endpoint budget can carry full encounter summary imports", () => {
  assert.ok(MAX_BODY_BYTES >= 16 * 1024 * 1024);
});

test("weekly raid-profile sync stores range snapshot without overwriting an existing full profile", async () => {
  const profileToken = "profile-device-token-weekly";
  const tokenHash = hashProfileDeviceToken(profileToken);
  const savedSnapshots = [];
  const User = {
    findOne(query) {
      assert.deepEqual(query, { localProfileSyncTokenHash: tokenHash });
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              localSyncEnabled: true,
              localProfileSyncTokenHash: tokenHash,
              localProfileSyncTokenExpAt: 9999999999,
              accounts: [
                {
                  accountName: "Roster",
                  characters: [
                    { name: "Aki", class: "Artist", itemLevel: 1750 },
                  ],
                },
              ],
            }),
          };
        },
      };
    },
    async updateOne() {
      return { modifiedCount: 1 };
    },
  };
  const RaidProfileSnapshot = {
    findOne(query) {
      assert.deepEqual(query, { discordId: "u1" });
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              rangeType: "full",
              criteria: { range: { type: "full" } },
              accounts: [
                {
                  accountName: "Roster",
                  characters: [{ name: "Aki", stats: { encounters: 20 } }],
                },
              ],
            }),
          };
        },
      };
    },
    async findOneAndUpdate(filter, update, options) {
      savedSnapshots.push({ filter, update, options });
      return { discordId: filter.discordId };
    },
  };
  const handler = createRaidProfileSyncEndpoint({ User, RaidProfileSnapshot });
  const res = makeRes();

  await handler(
    makeReq({
      token: profileToken,
      body: {
        generatedAt: 5000,
        criteria: {
          modernProfileStatsOnly: true,
          range: { type: "weekly", minFightStartMs: 123456789 },
        },
        accounts: [
          {
            accountName: "Roster",
            characters: [
              {
                name: "Aki",
                stats: { encounters: 2, lastFightStart: 123999999 },
                scores: { overall: 60 },
              },
            ],
          },
        ],
      },
    }),
    res,
    { query: {} }
  );

  assert.equal(res.status, 200);
  assert.equal(res.json().totals.encounterCount, 2);
  assert.equal(savedSnapshots.length, 1);
  const saved = savedSnapshots[0].update.$set;
  assert.equal(saved.discordId, "u1");
  assert.equal(saved.accounts, undefined);
  assert.equal(saved.rangeType, undefined);
  assert.equal(saved.criteria, undefined);
  const weekly = saved["rangeSnapshots.weekly"];
  assert.equal(weekly.rangeType, "weekly");
  assert.equal(weekly.criteria.range.type, "weekly");
  assert.equal(weekly.criteria.range.minFightStartMs, 123456789);
  assert.equal(weekly.accounts[0].characters[0].name, "Aki");
  assert.equal(weekly.accounts[0].characters[0].stats.encounters, 2);
});

test("weekly raid-profile sync can promote over an empty full snapshot shell", async () => {
  const profileToken = "profile-device-token-weekly-empty-shell";
  const tokenHash = hashProfileDeviceToken(profileToken);
  const savedSnapshots = [];
  const User = {
    findOne(query) {
      assert.deepEqual(query, { localProfileSyncTokenHash: tokenHash });
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              localSyncEnabled: true,
              localProfileSyncTokenHash: tokenHash,
              localProfileSyncTokenExpAt: 9999999999,
              accounts: [
                {
                  accountName: "Roster",
                  characters: [{ name: "Aki", class: "Artist", itemLevel: 1750 }],
                },
              ],
            }),
          };
        },
      };
    },
    async updateOne() {
      return { modifiedCount: 1 };
    },
  };
  const RaidProfileSnapshot = {
    findOne(query) {
      assert.deepEqual(query, { discordId: "u1" });
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              rangeType: "full",
              criteria: { range: { type: "full" } },
              accounts: [{ accountName: "Roster", characters: [] }],
            }),
          };
        },
      };
    },
    async findOneAndUpdate(filter, update, options) {
      savedSnapshots.push({ filter, update, options });
      return { discordId: filter.discordId };
    },
  };
  const handler = createRaidProfileSyncEndpoint({ User, RaidProfileSnapshot });
  const res = makeRes();

  await handler(
    makeReq({
      token: profileToken,
      body: {
        generatedAt: 5000,
        criteria: {
          modernProfileStatsOnly: true,
          range: { type: "weekly", minFightStartMs: 123456789 },
        },
        accounts: [
          {
            accountName: "Roster",
            characters: [
              {
                name: "Aki",
                stats: { encounters: 1, lastFightStart: 123999999 },
                scores: { overall: 60 },
              },
            ],
          },
        ],
      },
    }),
    res,
    { query: {} }
  );

  assert.equal(res.status, 200);
  assert.equal(savedSnapshots.length, 1);
  const saved = savedSnapshots[0].update.$set;
  assert.equal(saved.rangeType, "weekly");
  assert.equal(saved.accounts[0].characters[0].name, "Aki");
  assert.equal(saved["rangeSnapshots.weekly"].accounts[0].characters[0].stats.encounters, 1);
});

test("weekly raid-profile encounter summaries do not downgrade existing full encounter range", async () => {
  const profileToken = "profile-device-token-weekly-encounter";
  const tokenHash = hashProfileDeviceToken(profileToken);
  const savedEncounterWrites = [];
  const User = {
    findOne(query) {
      assert.deepEqual(query, { localProfileSyncTokenHash: tokenHash });
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              localSyncEnabled: true,
              localProfileSyncTokenHash: tokenHash,
              localProfileSyncTokenExpAt: 9999999999,
              accounts: [
                {
                  accountName: "Roster",
                  characters: [
                    { name: "Aki", class: "Artist", itemLevel: 1750 },
                  ],
                },
              ],
            }),
          };
        },
      };
    },
    async updateOne() {
      return { modifiedCount: 1 };
    },
  };
  const RaidProfileSnapshot = {
    findOne() {
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              rangeType: "full",
              criteria: { range: { type: "full" } },
              accounts: [{ accountName: "Roster", characters: [{ name: "Aki" }] }],
            }),
          };
        },
      };
    },
    async findOneAndUpdate(filter) {
      return { discordId: filter.discordId };
    },
  };
  const RaidProfileEncounter = {
    async bulkWrite(ops, options) {
      savedEncounterWrites.push({ ops, options });
      return { upsertedCount: 0, modifiedCount: ops.length };
    },
  };
  const handler = createRaidProfileSyncEndpoint({ User, RaidProfileSnapshot, RaidProfileEncounter });
  const res = makeRes();

  await handler(
    makeReq({
      token: profileToken,
      body: {
        generatedAt: 6000,
        criteria: {
          modernProfileStatsOnly: true,
          range: { type: "weekly", minFightStartMs: 123456789 },
        },
        accounts: [
          {
            accountName: "Roster",
            characters: [
              { name: "Aki", stats: { encounters: 1, lastFightStart: 123999999 } },
            ],
          },
        ],
        encounters: [
          {
            encounterId: "enc-weekly",
            accountName: "Roster",
            characterName: "Aki",
            fightStart: 123999999,
            durationMs: 420000,
            boss: "Abyss Lord Kazeros",
            raidKey: "kazeros",
            modeKey: "normal",
            metrics: { dps: 123 },
          },
        ],
      },
    }),
    res,
    { query: {} }
  );

  assert.equal(res.status, 200);
  assert.equal(savedEncounterWrites.length, 1);
  const encounterOp = savedEncounterWrites[0].ops[0].updateOne;
  assert.equal(encounterOp.update.$set.rangeType, undefined);
  assert.deepEqual(encounterOp.update.$setOnInsert, { rangeType: "weekly" });
  assert.equal(encounterOp.update.$set.metrics.dps, 123);
});
