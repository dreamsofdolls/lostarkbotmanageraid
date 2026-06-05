process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const { PassThrough } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

const { mintToken } = require("../bot/services/local-sync");
const { hashProfileDeviceToken } = require("../bot/services/local-sync/profile-device-token");
const {
  createProfileSessionEndpoint,
  createRaidProfileSyncEndpoint,
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
  const handler = createRaidProfileSyncEndpoint({ User, RaidProfileSnapshot });
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
                  avgDps: 123,
                  lastFightStart: 3000,
                  deathlessRate: 75,
                  deathRate: 25,
                  totalDeaths: 3,
                  avgDeaths: 0.25,
                  avgCritRate: 82.5,
                  avgBackAttackRate: 48,
                  avgFrontAttackRate: 3,
                  attackStyle: "back",
                  avgStaggerPerMinute: 1600,
                  avgDamageTakenPerMinute: 45000,
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
                },
                scores: { overall: 88.8, mvp: 77.7, protection: 45.6 },
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
              },
              {
                name: "OffRoster",
                stats: { encounters: 99 },
                scores: { overall: 100 },
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
  assert.equal(saved.accounts[0].characters[0].stats.totalDeaths, 3);
  assert.equal(saved.accounts[0].characters[0].stats.avgDeaths, 0.25);
  assert.equal(saved.accounts[0].characters[0].stats.deathRate, 25);
  assert.equal(saved.accounts[0].characters[0].stats.attackStyle, "back");
  assert.equal(saved.accounts[0].characters[0].stats.avgCritRate, 82.5);
  assert.equal(saved.accounts[0].characters[0].stats.avgSynergyGivenPerMinute, 12345);
  assert.equal(saved.accounts[0].characters[0].stats.avgProtectionPerMinute, 456789);
  assert.equal(saved.accounts[0].characters[0].stats.avgPartyBuffedShare, 133.7);
  assert.equal(saved.accounts[0].characters[0].stats.avgPartyDebuffedShare, 101.2);
  assert.equal(saved.accounts[0].characters[0].stats.latestGearScore, 1755);
  assert.equal(saved.accounts[0].characters[0].stats.arkPassiveRate, 50);
  assert.equal(saved.accounts[0].characters[0].stats.buildVariantCount, 2);
  assert.equal(saved.accounts[0].characters[0].scores.protection, 45.6);
  assert.equal(saved.accounts[0].characters[0].build.spec, "Full Bloom");
  assert.equal(saved.accounts[0].characters[0].build.engravings.length, 2);
  assert.equal(saved.accounts[0].characters[0].build.arkPassive.evolution.points, 40);
  assert.equal(saved.accounts[0].characters[0].build.arkPassive.enlightenment.spec, "Full Bloom");
  assert.equal(saved.accounts[0].characters[0].build.arkPassive.enlightenment.spentPoints, 24);
  assert.equal(saved.accounts[0].characters[0].build.arkPassive.enlightenment.nodes[0].name, "Setting Moon");
  assert.equal(saved.accounts[0].characters[0].topSkills.length, 1);
  assert.equal(saved.accounts[0].characters[0].topSkills[0].name, "Main Skill");
  assert.equal(saved.accounts[0].characters[0].topSkills[0].share, 42.5);
  assert.equal(saved.accounts[0].characters[0].topBuffSources[0].name, "God's Decree");
  assert.equal(saved.accounts[0].characters[0].topDebuffSources[0].category, "battleitem");
  assert.equal(saved.accounts[0].characters[0].topShieldGivenSources[0].target, "OTHER");
  assert.equal(saved.accounts[0].characters[0].topShieldReceivedSources[0].share, 45.6);
  assert.equal(saved.rangeType, "full");
  assert.equal(saved.criteria.modernProfileStatsOnly, true);
  assert.equal(saved.criteria.range.type, "full");
  assert.equal(saved["rangeSnapshots.full"].criteria.range.type, "full");
  assert.equal(saved.totals.encounterCount, 12);
  assert.equal(userUpdates.length, 1);
  assert.deepEqual(userUpdates[0].filter, {
    discordId: "u1",
    localProfileSyncTokenHash: tokenHash,
  });
  assert.equal(typeof userUpdates[0].update.$set.lastLocalProfileSyncAt, "number");
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
