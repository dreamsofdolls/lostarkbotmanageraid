// Tests for the atomic enable-auto helper used by /raid-check button
// "Bật auto-sync hộ <user>". Earlier shape was a read-then-update which
// leaked a race: 2 managers (or manager + user clicking action:on) could
// both pass the read and both produce success embeds + duplicate DMs.
// Codex round flagged the race; this suite pins the CAS contract in
// place so a future refactor can't silently regress it.
//
// The helper is module-level (not bound to the createRaidCheckCommand
// closure) so the suite can pass a stub UserModel and exercise all 4
// outcomes without spinning up the full /raid-check command factory.

process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const { tryEnableAutoManageForUser } = require("../src/commands/raid-check");

// Build a stub UserModel that records the filter passed to
// findOneAndUpdate + lets each test plant its own findOneAndUpdate /
// findOne result. The real Mongoose model has a chainable .select().lean()
// API for findOne so the stub mirrors that shape.
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
      // Mongoose-style chain so the helper's `.select(...).lean()` works.
      return {
        select: () => ({
          lean: () => {
            if (typeof findOneImpl === "function") {
              return findOneImpl(filter);
            }
            return Promise.resolve(null);
          },
        }),
      };
    },
  };
}

test("tryEnableAutoManageForUser returns 'missing' when discordId is empty (defensive guard)", async () => {
  const UserStub = makeUserStub();
  const result = await tryEnableAutoManageForUser(UserStub, "");
  assert.equal(result.outcome, "missing");
  // Should short-circuit BEFORE any DB call.
  assert.equal(UserStub.calls.findOneAndUpdate.length, 0);
  assert.equal(UserStub.calls.findOne.length, 0);
});

test("tryEnableAutoManageForUser returns 'flipped' when CAS filter matches", async () => {
  const updatedDoc = {
    discordId: "user-1",
    autoManageEnabled: true,
  };
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(updatedDoc),
  });
  const result = await tryEnableAutoManageForUser(UserStub, "user-1");
  assert.equal(result.outcome, "flipped");
  assert.equal(result.doc, updatedDoc);
  // Critically: the CAS filter MUST include autoManageEnabled $ne true so
  // a doc that's already been flipped by a concurrent path is rejected.
  // Codex round flagged the prior non-atomic shape - regression guard.
  assert.equal(UserStub.calls.findOneAndUpdate.length, 1);
  const call = UserStub.calls.findOneAndUpdate[0];
  assert.equal(call.filter.discordId, "user-1");
  assert.deepEqual(call.filter.autoManageEnabled, { $ne: true });
  // No fallback findOne in the success path.
  assert.equal(UserStub.calls.findOne.length, 0);
});

test("tryEnableAutoManageForUser update payload does NOT stamp lastAutoManageAttemptAt", async () => {
  // Codex round 28 #2: stamping lastAutoManageAttemptAt here would push
  // the new opt-in to the tail of the daily scheduler's ascending sort
  // (sorted by exactly that field), contradicting the "next tick will
  // pick up your roster" copy. Leaving the field as null gives the new
  // user priority. Pin the contract so a future refactor doesn't quietly
  // re-introduce the stamp.
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () =>
      Promise.resolve({ discordId: "user-1", autoManageEnabled: true }),
  });
  await tryEnableAutoManageForUser(UserStub, "user-1");
  const call = UserStub.calls.findOneAndUpdate[0];
  assert.deepEqual(Object.keys(call.update.$set).sort(), ["autoManageEnabled"]);
  assert.equal(call.update.$set.autoManageEnabled, true);
  assert.ok(
    !("lastAutoManageAttemptAt" in call.update.$set),
    "$set must not stamp lastAutoManageAttemptAt"
  );
});

test("tryEnableAutoManageForUser returns 'already-on' when CAS rejects but doc still exists", async () => {
  // Race: a concurrent path flipped the flag between page render and
  // click. The CAS filter rejects; the fallback findOne sees the doc
  // with autoManageEnabled=true. Outcome 'already-on' is benign (UX
  // tells leader to refresh).
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null),
    findOneImpl: () =>
      Promise.resolve({ _id: "id-1", autoManageEnabled: true }),
  });
  const result = await tryEnableAutoManageForUser(UserStub, "user-1");
  assert.equal(result.outcome, "already-on");
  assert.equal(UserStub.calls.findOneAndUpdate.length, 1);
  assert.equal(UserStub.calls.findOne.length, 1);
});

test("tryEnableAutoManageForUser returns 'missing' when CAS rejects AND fallback finds no doc", async () => {
  // Race: user removed their roster entirely between page render and
  // click. CAS rejects (filter on discordId fails), fallback also gone.
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null),
    findOneImpl: () => Promise.resolve(null),
  });
  const result = await tryEnableAutoManageForUser(UserStub, "user-gone");
  assert.equal(result.outcome, "missing");
});

test("tryEnableAutoManageForUser returns 'error' when findOneAndUpdate throws", async () => {
  const dbErr = new Error("Mongo timeout");
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.reject(dbErr),
  });
  const result = await tryEnableAutoManageForUser(UserStub, "user-1");
  assert.equal(result.outcome, "error");
  assert.equal(result.error, dbErr);
  // Must not fall through to findOne probe when CAS itself errored - that
  // could mask the original failure with a misleading 'missing' outcome.
  assert.equal(UserStub.calls.findOne.length, 0);
});

test("tryEnableAutoManageForUser tolerates findOne throwing in the fallback path", async () => {
  // CAS rejects + fallback read errors. We treat unknown state as
  // 'missing' rather than crashing - the leader gets the refresh-page
  // hint instead of a stack trace.
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null),
    findOneImpl: () => Promise.reject(new Error("Mongo blip")),
  });
  const result = await tryEnableAutoManageForUser(UserStub, "user-1");
  assert.equal(result.outcome, "missing");
});
