const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDevUserIds, isDevUser } = require("../bot/services/access/dev-preview");
const { createBibleProfileSyncService } = require("../bot/services/auto-manage/profile-sync");

test("dev-preview parses comma/space-separated ids and checks membership", () => {
  const ids = parseDevUserIds(" 111 , 222 ,,333  444 ");
  assert.deepEqual([...ids], ["111", "222", "333", "444"]);
  assert.equal(ids.has("222"), true);
  assert.equal(ids.has("999"), false);
  assert.equal(parseDevUserIds("").size, 0);
  // Quoted .env value (DEV_USER="123") must still resolve to a bare id.
  assert.equal(parseDevUserIds('"123456789"').has("123456789"), true);
  // Module-level isDevUser reads the real DEV_USER env, which is unset under
  // the test runner -> fail-closed -> nobody is in the preview.
  assert.equal(isDevUser("111"), false);
  assert.equal(isDevUser(""), false);
  assert.equal(isDevUser(undefined), false);
});

test("bible profile-light sync is preview-gated for non-DEV_USER", async () => {
  const writes = [];
  const deps = {
    RaidProfileSnapshot: { updateOne: async (filter) => { writes.push(filter); return {}; } },
    getCharacterName: () => "Char",
    getCharacterClass: () => "Bard",
    getRaidGateForBoss: () => null,
    RAID_REQUIREMENT_MAP: {},
    isDevUser: () => false,
  };
  const service = createBibleProfileSyncService(deps);

  const result = await service.syncRaidProfileFromBibleCollected({
    discordId: "u-not-dev",
    userDoc: { discordId: "u-not-dev" },
    weekResetStart: 0,
    collected: [{ boss: "Aegir", fightStart: 1 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "preview-gated");
  // Gate short-circuits before any snapshot write.
  assert.equal(writes.length, 0);
});
