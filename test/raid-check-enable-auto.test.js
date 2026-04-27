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

const {
  tryEnableAutoManage,
  tryDisableAutoManage,
  buildEnableAutoDmEmbed,
  buildDisableAutoDmEmbed,
} = require("../src/commands/raid-check");
const { EmbedBuilder } = require("discord.js");

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

test("tryEnableAutoManage returns 'missing' when discordId is empty (defensive guard)", async () => {
  const UserStub = makeUserStub();
  const result = await tryEnableAutoManage(UserStub, "");
  assert.equal(result.outcome, "missing");
  // Should short-circuit BEFORE any DB call.
  assert.equal(UserStub.calls.findOneAndUpdate.length, 0);
  assert.equal(UserStub.calls.findOne.length, 0);
});

test("tryEnableAutoManage returns 'flipped' when CAS filter matches", async () => {
  const updatedDoc = {
    discordId: "user-1",
    autoManageEnabled: true,
  };
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(updatedDoc),
  });
  const result = await tryEnableAutoManage(UserStub, "user-1");
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

test("tryEnableAutoManage update payload does NOT stamp lastAutoManageAttemptAt", async () => {
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
  await tryEnableAutoManage(UserStub, "user-1");
  const call = UserStub.calls.findOneAndUpdate[0];
  assert.deepEqual(Object.keys(call.update.$set).sort(), ["autoManageEnabled"]);
  assert.equal(call.update.$set.autoManageEnabled, true);
  assert.ok(
    !("lastAutoManageAttemptAt" in call.update.$set),
    "$set must not stamp lastAutoManageAttemptAt"
  );
});

test("tryEnableAutoManage returns 'already-on' when CAS rejects but doc still exists", async () => {
  // Race: a concurrent path flipped the flag between page render and
  // click. The CAS filter rejects; the fallback findOne sees the doc
  // with autoManageEnabled=true. Outcome 'already-on' is benign (UX
  // tells leader to refresh).
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null),
    findOneImpl: () =>
      Promise.resolve({ _id: "id-1", autoManageEnabled: true }),
  });
  const result = await tryEnableAutoManage(UserStub, "user-1");
  assert.equal(result.outcome, "already-on");
  assert.equal(UserStub.calls.findOneAndUpdate.length, 1);
  assert.equal(UserStub.calls.findOne.length, 1);
});

test("tryEnableAutoManage returns 'missing' when CAS rejects AND fallback finds no doc", async () => {
  // Race: user removed their roster entirely between page render and
  // click. CAS rejects (filter on discordId fails), fallback also gone.
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null),
    findOneImpl: () => Promise.resolve(null),
  });
  const result = await tryEnableAutoManage(UserStub, "user-gone");
  assert.equal(result.outcome, "missing");
});

test("tryEnableAutoManage returns 'error' when findOneAndUpdate throws", async () => {
  const dbErr = new Error("Mongo timeout");
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.reject(dbErr),
  });
  const result = await tryEnableAutoManage(UserStub, "user-1");
  assert.equal(result.outcome, "error");
  assert.equal(result.error, dbErr);
  // Must not fall through to findOne probe when CAS itself errored - that
  // could mask the original failure with a misleading 'missing' outcome.
  assert.equal(UserStub.calls.findOne.length, 0);
});

test("tryEnableAutoManage tolerates findOne throwing in the fallback path", async () => {
  // CAS rejects + fallback read errors. We treat unknown state as
  // 'missing' rather than crashing - the leader gets the refresh-page
  // hint instead of a stack trace.
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null),
    findOneImpl: () => Promise.reject(new Error("Mongo blip")),
  });
  const result = await tryEnableAutoManage(UserStub, "user-1");
  assert.equal(result.outcome, "missing");
});

// --------- tryDisableAutoManage (Option C quick-undo button) ---------
//
// The disable variant mirrors the enable helper but flips true → false.
// Used by the per-user "🚫 Tắt auto-sync ngay" button shipped in the DM
// after a Manager bật-hộ. Self-only enforcement happens in the click
// handler; this helper just owns the atomic state transition.

test("tryDisableAutoManage returns 'disabled' when CAS filter matches", async () => {
  const updatedDoc = { discordId: "user-1", autoManageEnabled: false };
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(updatedDoc),
  });
  const result = await tryDisableAutoManage(UserStub, "user-1");
  assert.equal(result.outcome, "disabled");
  assert.equal(result.doc, updatedDoc);
  // Filter must require autoManageEnabled === true (not $ne false) so
  // the helper rejects an already-off doc and routes to the fallback
  // probe instead of double-flipping silently.
  const call = UserStub.calls.findOneAndUpdate[0];
  assert.equal(call.filter.discordId, "user-1");
  assert.equal(call.filter.autoManageEnabled, true);
  assert.deepEqual(call.update.$set, { autoManageEnabled: false });
});

test("tryDisableAutoManage returns 'already-off' when CAS rejects but doc still exists", async () => {
  // User clicked the button twice in a row, or hit /raid-auto-manage
  // action:off in parallel. Outcome 'already-off' is benign (UI tells
  // them nothing to change).
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null),
    findOneImpl: () =>
      Promise.resolve({ _id: "id-1", autoManageEnabled: false }),
  });
  const result = await tryDisableAutoManage(UserStub, "user-1");
  assert.equal(result.outcome, "already-off");
});

test("tryDisableAutoManage returns 'missing' when doc is gone entirely", async () => {
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.resolve(null),
    findOneImpl: () => Promise.resolve(null),
  });
  const result = await tryDisableAutoManage(UserStub, "user-1");
  assert.equal(result.outcome, "missing");
});

test("tryDisableAutoManage returns 'error' when findOneAndUpdate throws", async () => {
  const dbErr = new Error("Mongo timeout");
  const UserStub = makeUserStub({
    findOneAndUpdateImpl: () => Promise.reject(dbErr),
  });
  const result = await tryDisableAutoManage(UserStub, "user-1");
  assert.equal(result.outcome, "error");
  assert.equal(result.error, dbErr);
});

// --------- buildEnableAutoDmEmbed (Option C DM with roster + log status) ---------
//
// The DM lists every char with one of three Public Log status icons so
// the user knows which chars they need to flip on lostark.bible AFTER
// the Manager turns auto-sync on. Status rules are sticky and easy to
// regress on if someone later swaps default semantics, so the suite
// pins the icon contract.

function makeUserDoc({
  accounts = [],
  lastAutoManageSyncAt = 0,
  autoManageEnabled = true,
} = {}) {
  return { autoManageEnabled, lastAutoManageSyncAt, accounts };
}

test("buildEnableAutoDmEmbed: emits 🔓 Public OK for chars when user has synced before AND publicLogDisabled=false", () => {
  const userDoc = makeUserDoc({
    lastAutoManageSyncAt: 1700000000000, // any positive timestamp
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { name: "Cyrano", itemLevel: 1733, publicLogDisabled: false },
        ],
      },
    ],
  });
  const embed = buildEnableAutoDmEmbed(EmbedBuilder, {
    managerId: "manager-1",
    userDoc,
  });
  const json = embed.toJSON();
  const fields = json.fields || [];
  assert.equal(fields.length, 1);
  assert.match(fields[0].value, /🔓 Cyrano · 1733 · Public OK/);
});

test("buildEnableAutoDmEmbed: emits 🔒 Private for chars with publicLogDisabled=true", () => {
  const userDoc = makeUserDoc({
    lastAutoManageSyncAt: 1700000000000,
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { name: "Naila", itemLevel: 1730, publicLogDisabled: true },
        ],
      },
    ],
  });
  const embed = buildEnableAutoDmEmbed(EmbedBuilder, {
    managerId: "manager-1",
    userDoc,
  });
  const fields = embed.toJSON().fields || [];
  assert.match(fields[0].value, /🔒 Naila · 1730 · Private \(cần bật Public Log\)/);
});

test("buildEnableAutoDmEmbed: emits ❓ Chưa kiểm tra when user has never synced (lastAutoManageSyncAt=0)", () => {
  const userDoc = makeUserDoc({
    lastAutoManageSyncAt: 0,
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { name: "Cyrano", itemLevel: 1733, publicLogDisabled: false },
        ],
      },
    ],
  });
  const embed = buildEnableAutoDmEmbed(EmbedBuilder, {
    managerId: "manager-1",
    userDoc,
  });
  const fields = embed.toJSON().fields || [];
  assert.match(fields[0].value, /❓ Cyrano · 1733 · Chưa kiểm tra/);
});

test("buildEnableAutoDmEmbed: footer hint appears when at least one char is Private OR unknown", () => {
  const userDoc = makeUserDoc({
    lastAutoManageSyncAt: 0, // never synced → all chars unknown
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { name: "Cyrano", itemLevel: 1733, publicLogDisabled: false },
        ],
      },
    ],
  });
  const embed = buildEnableAutoDmEmbed(EmbedBuilder, {
    managerId: "manager-1",
    userDoc,
  });
  const json = embed.toJSON();
  assert.ok(json.footer, "footer should be set when chars are unknown/private");
  assert.match(json.footer.text, /lostark\.bible|Show on Profile/);
});

test("buildEnableAutoDmEmbed: footer hint OMITTED when every char is confirmed Public", () => {
  const userDoc = makeUserDoc({
    lastAutoManageSyncAt: 1700000000000,
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { name: "Cyrano", itemLevel: 1733, publicLogDisabled: false },
          { name: "Naila", itemLevel: 1730, publicLogDisabled: false },
        ],
      },
    ],
  });
  const embed = buildEnableAutoDmEmbed(EmbedBuilder, {
    managerId: "manager-1",
    userDoc,
  });
  const json = embed.toJSON();
  // Footer should NOT exist when all chars are Public OK - the hint
  // would just be visual noise.
  assert.equal(json.footer, undefined);
});

test("buildEnableAutoDmEmbed: emits one field per non-empty account, omits empty accounts", () => {
  const userDoc = makeUserDoc({
    lastAutoManageSyncAt: 0,
    accounts: [
      {
        accountName: "Alpha",
        characters: [{ name: "Cyrano", itemLevel: 1733, publicLogDisabled: false }],
      },
      { accountName: "Beta", characters: [] }, // empty - skip
      {
        accountName: "Gamma",
        characters: [{ name: "Bao", itemLevel: 1745, publicLogDisabled: false }],
      },
    ],
  });
  const embed = buildEnableAutoDmEmbed(EmbedBuilder, {
    managerId: "manager-1",
    userDoc,
  });
  const json = embed.toJSON();
  const fields = json.fields || [];
  assert.equal(fields.length, 2, "empty Beta account should be skipped");
  assert.match(fields[0].name, /Alpha/);
  assert.match(fields[1].name, /Gamma/);
});

test("buildEnableAutoDmEmbed: includes manager mention in description", () => {
  const userDoc = makeUserDoc({ accounts: [] });
  const embed = buildEnableAutoDmEmbed(EmbedBuilder, {
    managerId: "manager-7",
    userDoc,
  });
  const json = embed.toJSON();
  assert.match(json.description, /<@manager-7>/);
});

// --------- buildDisableAutoDmEmbed (Manager-on-behalf disable DM) ---------
//
// Mirror of the enable DM but with disable-tone copy. Doesn't include a
// roster status section because nothing about the user's chars matters
// when stopping data collection - the symmetric reduce keeps the
// disable DM short.

test("buildDisableAutoDmEmbed: includes manager mention in description", () => {
  const embed = buildDisableAutoDmEmbed(EmbedBuilder, { managerId: "manager-9" });
  const json = embed.toJSON();
  assert.match(json.description, /<@manager-9>/);
});

test("buildDisableAutoDmEmbed: states ON→OFF transition + opt-back-in path explicitly", () => {
  const embed = buildDisableAutoDmEmbed(EmbedBuilder, { managerId: "manager-1" });
  const json = embed.toJSON();
  assert.match(json.description, /Trạng thái mới.*OFF/);
  // Re-enable path must be advertised so the user has agency to revert
  // without having to figure out the slash command from scratch.
  assert.match(json.description, /Bật lại nhanh|action:on/);
});

test("buildDisableAutoDmEmbed: emits no roster fields (disable case skips status section by design)", () => {
  const embed = buildDisableAutoDmEmbed(EmbedBuilder, { managerId: "manager-1" });
  const json = embed.toJSON();
  // Field count matters: any roster sections here would imply we still
  // need the user to act on Public Log, which is irrelevant once auto-
  // sync is off.
  assert.equal((json.fields || []).length, 0);
});
