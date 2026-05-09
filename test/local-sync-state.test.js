// Phase 1 (2026-05-09): cover the local-sync mutex helpers in
// bot/services/local-sync/state.js. The mutex enforcement lives at the
// Mongo write layer (conditional findOneAndUpdate), so each test
// validates BOTH the filter shape AND the result-code dispatch on
// stub responses for the 3 outcome paths (ok / conflict / no_user).
//
// Helper unit tests only - no real Mongo. The integration boundary
// (real driver, real upsert, real concurrent flips) is left to the
// runtime + manual smoke since it depends on Mongo's atomic semantics
// which are well-documented and not bot-side logic.

process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SYNC_MODE,
  RESULT,
  setLocalSyncEnabled,
  setBibleAutoSyncEnabled,
  resolveSyncMode,
  getSyncStatus,
  recordLocalSyncSuccess,
} = require("../bot/services/local-sync");

function makeUserStub({ findOneAndUpdateImpl, findOneImpl } = {}) {
  const calls = { findOneAndUpdate: [], findOne: [] };
  return {
    calls,
    findOneAndUpdate: (filter, update, options) => {
      calls.findOneAndUpdate.push({ filter, update, options });
      if (typeof findOneAndUpdateImpl === "function") {
        return findOneAndUpdateImpl(filter, update, options);
      }
      return Promise.resolve(null);
    },
    findOne: (filter) => {
      calls.findOne.push({ filter });
      return {
        select: () => ({
          lean: () => {
            if (typeof findOneImpl === "function") {
              return findOneImpl(filter);
            }
            return Promise.resolve(null);
          },
        }),
        // Plain .lean() (no .select) for the conflict-probe path in
        // setLocalSyncEnabled / setBibleAutoSyncEnabled.
        lean: () => {
          if (typeof findOneImpl === "function") {
            return findOneImpl(filter);
          }
          return Promise.resolve(null);
        },
      };
    },
  };
}

// ---------- setLocalSyncEnabled ----------

test("setLocalSyncEnabled(true) without force - filter rejects when bible is on, returns conflict", async () => {
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null), // CAS missed
    findOneImpl: () => Promise.resolve({ autoManageEnabled: true }),
  });
  const result = await setLocalSyncEnabled("u1", true, {}, { UserModel: UserStub });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RESULT.conflict);
  // Filter MUST gate on autoManageEnabled $ne true so a doc with bible
  // already on never lands the local-on flip in non-force mode.
  assert.deepEqual(UserStub.calls.findOneAndUpdate[0].filter, {
    discordId: "u1",
    autoManageEnabled: { $ne: true },
  });
  // Probe was made to disambiguate noUser vs conflict.
  assert.equal(UserStub.calls.findOne.length, 1);
});

test("setLocalSyncEnabled(true) without force - happy path stamps localSyncLinkedAt", async () => {
  const before = Date.now();
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: (filter, update) =>
      Promise.resolve({ discordId: "u1", localSyncEnabled: true, ...update.$set }),
  });
  const result = await setLocalSyncEnabled("u1", true, {}, { UserModel: UserStub });
  assert.equal(result.ok, true);
  assert.equal(result.reason, RESULT.ok);
  const update = UserStub.calls.findOneAndUpdate[0].update;
  assert.equal(update.$set.localSyncEnabled, true);
  assert.ok(update.$set.localSyncLinkedAt >= before);
  // No probe needed on the happy path.
  assert.equal(UserStub.calls.findOne.length, 0);
});

test("setLocalSyncEnabled(true) with force - flips autoManageEnabled OFF in same atomic update", async () => {
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: (filter, update) =>
      Promise.resolve({ discordId: "u1", ...update.$set }),
  });
  const result = await setLocalSyncEnabled("u1", true, { force: true }, { UserModel: UserStub });
  assert.equal(result.ok, true);
  const update = UserStub.calls.findOneAndUpdate[0].update;
  // Force-mode MUST clear bible flag in the same write so a concurrent
  // bible scheduler tick can't see localSync ON + bible ON briefly.
  assert.equal(update.$set.autoManageEnabled, false);
  assert.equal(update.$set.localSyncEnabled, true);
  // Filter is unconditional on bible state for force-mode.
  assert.deepEqual(UserStub.calls.findOneAndUpdate[0].filter, { discordId: "u1" });
});

test("setLocalSyncEnabled(false) clears localSyncLinkedAt", async () => {
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: (filter, update) =>
      Promise.resolve({ discordId: "u1", ...update.$set }),
  });
  const result = await setLocalSyncEnabled("u1", false, {}, { UserModel: UserStub });
  assert.equal(result.ok, true);
  const update = UserStub.calls.findOneAndUpdate[0].update;
  assert.equal(update.$set.localSyncEnabled, false);
  assert.equal(update.$set.localSyncLinkedAt, null);
});

// ---------- setBibleAutoSyncEnabled ----------

test("setBibleAutoSyncEnabled(true) without force - rejects when local is on, returns conflict", async () => {
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null),
    findOneImpl: () => Promise.resolve({ localSyncEnabled: true }),
  });
  const result = await setBibleAutoSyncEnabled("u1", true, {}, { UserModel: UserStub });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RESULT.conflict);
  assert.deepEqual(UserStub.calls.findOneAndUpdate[0].filter, {
    discordId: "u1",
    localSyncEnabled: { $ne: true },
  });
});

test("setBibleAutoSyncEnabled(true) with stampLastAttempt - includes timestamp in $set", async () => {
  const before = Date.now();
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: (filter, update) =>
      Promise.resolve({ discordId: "u1", ...update.$set }),
  });
  const result = await setBibleAutoSyncEnabled(
    "u1",
    true,
    { stampLastAttempt: true },
    { UserModel: UserStub }
  );
  assert.equal(result.ok, true);
  const update = UserStub.calls.findOneAndUpdate[0].update;
  assert.equal(update.$set.autoManageEnabled, true);
  assert.ok(update.$set.lastAutoManageAttemptAt >= before);
});

test("setBibleAutoSyncEnabled(true) with force - clears localSyncEnabled in same write", async () => {
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: (filter, update) =>
      Promise.resolve({ discordId: "u1", ...update.$set }),
  });
  const result = await setBibleAutoSyncEnabled("u1", true, { force: true }, { UserModel: UserStub });
  assert.equal(result.ok, true);
  const update = UserStub.calls.findOneAndUpdate[0].update;
  assert.equal(update.$set.autoManageEnabled, true);
  assert.equal(update.$set.localSyncEnabled, false);
  assert.equal(update.$set.localSyncLinkedAt, null);
});

// ---------- resolveSyncMode (pure) ----------

test("resolveSyncMode - prefers local when both flags set (defensive)", () => {
  // The mutex helpers prevent both flags being true at write time, but a
  // legacy doc could have inconsistent state. Local wins so the user
  // doesn't get bible polling stomping on local-sync data.
  assert.equal(
    resolveSyncMode({ localSyncEnabled: true, autoManageEnabled: true }),
    SYNC_MODE.local
  );
});

test("resolveSyncMode - bible when only autoManageEnabled", () => {
  assert.equal(
    resolveSyncMode({ autoManageEnabled: true, localSyncEnabled: false }),
    SYNC_MODE.bible
  );
});

test("resolveSyncMode - off when neither flag set / null doc", () => {
  assert.equal(resolveSyncMode({}), SYNC_MODE.off);
  assert.equal(resolveSyncMode(null), SYNC_MODE.off);
});

// ---------- getSyncStatus ----------

test("getSyncStatus - returns all-off shape when user doc missing", async () => {
  const UserStub = makeUserStub({
    findOneImpl: () => Promise.resolve(null),
  });
  const status = await getSyncStatus("u1", { UserModel: UserStub });
  assert.equal(status.mode, SYNC_MODE.off);
  assert.equal(status.bible.enabled, false);
  assert.equal(status.local.enabled, false);
  assert.equal(status.local.lastSyncAt, null);
});

test("getSyncStatus - mirrors flags + timestamps when present", async () => {
  const UserStub = makeUserStub({
    findOneImpl: () =>
      Promise.resolve({
        autoManageEnabled: false,
        localSyncEnabled: true,
        lastAutoManageSyncAt: 100,
        lastAutoManageAttemptAt: 200,
        lastLocalSyncAt: 300,
        localSyncLinkedAt: 400,
      }),
  });
  const status = await getSyncStatus("u1", { UserModel: UserStub });
  assert.equal(status.mode, SYNC_MODE.local);
  assert.equal(status.bible.lastSyncAt, 100);
  assert.equal(status.bible.lastAttemptAt, 200);
  assert.equal(status.local.lastSyncAt, 300);
  assert.equal(status.local.linkedAt, 400);
});

// ---------- recordLocalSyncSuccess ----------

test("recordLocalSyncSuccess - filter requires localSyncEnabled=true (stale POST guard)", async () => {
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null), // user opted out between mint + POST
  });
  const result = await recordLocalSyncSuccess("u1", { UserModel: UserStub });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RESULT.conflict);
  assert.deepEqual(UserStub.calls.findOneAndUpdate[0].filter, {
    discordId: "u1",
    localSyncEnabled: true,
  });
});

test("recordLocalSyncSuccess - stamps lastLocalSyncAt on success", async () => {
  const before = Date.now();
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: (filter, update) =>
      Promise.resolve({ discordId: "u1", ...update.$set }),
  });
  const result = await recordLocalSyncSuccess("u1", { UserModel: UserStub });
  assert.equal(result.ok, true);
  const update = UserStub.calls.findOneAndUpdate[0].update;
  assert.ok(update.$set.lastLocalSyncAt >= before);
});

// ---------- defensive guards ----------

test("setLocalSyncEnabled - throws when UserModel missing from deps", async () => {
  await assert.rejects(
    setLocalSyncEnabled("u1", true, {}, {}),
    /UserModel required/
  );
});

test("setBibleAutoSyncEnabled - throws when UserModel missing from deps", async () => {
  await assert.rejects(
    setBibleAutoSyncEnabled("u1", true, {}, {}),
    /UserModel required/
  );
});
