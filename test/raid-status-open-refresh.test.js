"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRaidStatusCommand } = require("../bot/handlers/raid-status");
const User = require("../bot/models/user");
const { t: translate } = require("../bot/services/i18n");
const {
  createCollectorMessage,
  createStatusCommandDeps,
  mockStatusSideReads,
} = require("./helpers/raid-status-command-fixture");

const flushBackground = async () => {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
};
const embedText = payload => JSON.stringify(payload.embeds.map(embed => embed.toJSON()));

function createFixture(t, { localSync = false, slowBible = false, slowRoster = false, onFirstReply = null,
  failBibleGather = false, failBackgroundApply = false } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const originalBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "";
  t.after(() => {
    if (originalBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = originalBaseUrl;
  });
  let databaseDoc = {
    discordId: "open-refresh-viewer", language: "en",
    autoManageEnabled: !localSync, localSyncEnabled: localSync,
    accounts: [{ accountName: "Roster", characters: [{ name: "Before", itemLevel: 1740,
      raids: [{ raidKey: "armoche", modeKey: "normal", raidName: "Act 4 Normal", goldReceives: true, isCompleted: false }] }] }],
  };
  let reads = 0, gathers = 0, releases = 0, applies = 0, failureStamps = 0;
  t.mock.method(User, "findOne", () => {
    reads += 1;
    const snapshot = structuredClone(databaseDoc);
    const doc = structuredClone(snapshot);
    Object.defineProperties(doc, {
      save: { value: async () => { databaseDoc = structuredClone(doc); } },
      toObject: { value: () => structuredClone(doc) },
    });
    return { select() { return this; }, lean: async () => snapshot,
      then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject) };
  });
  mockStatusSideReads(t);
  const listeners = new Map(), edits = [];
  let finishBible, finishRoster;
  const heldBible = new Promise(resolve => { finishBible = resolve; });
  const heldRoster = new Promise(resolve => { finishRoster = resolve; });
  const markUpdated = doc => {
    doc.accounts[0].characters[0].name = "After";
    doc.accounts[0].characters[0].raids[0].isCompleted = true;
    doc.lastAutoManageSyncAt = Date.now();
    doc.lastLocalSyncAt = Date.now();
  };
  const message = createCollectorMessage(listeners);
  const interaction = { user: { id: databaseDoc.discordId }, guildId: "guild",
    deferReply: async () => {}, editReply: async payload => {
      edits.push(payload);
      if (edits.length === 1 && onFirstReply) onFirstReply(() => markUpdated(databaseDoc));
      return message;
    } };
  const command = createRaidStatusCommand(createStatusCommandDeps({
    collectStaleAccountRefreshes: async () => slowRoster ? heldRoster : [],
    applyStaleAccountRefreshes: () => false,
    getStatusRaidsForCharacter: char => char.raids,
    weekResetStartMs: () => 0,
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => { releases += 1; },
    gatherAutoManageLogsForUserDoc: async () => {
      gathers += 1;
      const collected = slowBible ? await heldBible : {};
      if (failBibleGather) throw new Error("offline fixture: Bible unavailable");
      return collected;
    },
    waitWithBudget: async (pending, budget) => slowBible && budget === 2500
      ? { timedOut: true, value: null } : { timedOut: false, value: await pending },
    applyAutoManageCollected: doc => { markUpdated(doc); return { perChar: [{ applied: ["G1", "G2"] }] }; },
    applyAutoManageCollectedForStatus: async (_discordId, _week, collected) => {
      applies += 1;
      if (failBackgroundApply) throw new Error("offline fixture: background persistence failed");
      if (collected) markUpdated(databaseDoc);
      else databaseDoc.lastAutoManageAttemptAt = Date.now();
      return structuredClone(databaseDoc);
    },
    stampAutoManageAttempt: async () => { failureStamps += 1; },
  }));
  return {
    edits,
    open: () => command.handleStatusCommand(interaction),
    finishBible: () => finishBible({}),
    finishRoster: () => finishRoster([]),
    stats: () => ({ reads, gathers, releases, applies, failureStamps }),
    end: () => listeners.get("end")?.(),
    cleanup: async () => { finishBible({}); finishRoster([]); await flushBackground(); await listeners.get("end")?.(); },
  };
}

test("opening Local Sync status reads newly saved data without a click or waiting for roster fetch", async t => {
  const fixture = createFixture(t, { localSync: true, slowRoster: true, onFirstReply: update => update() });
  try {
    await fixture.open();
    await flushBackground();
    assert.match(embedText(fixture.edits.at(-1)), /After/);
    assert.doesNotMatch(embedText(fixture.edits.at(-1)), /Before/);
    assert.equal(fixture.stats().gathers, 0, "Local Sync must not start a Bible scan");
    const reads = fixture.stats().reads;
    await flushBackground();
    assert.equal(fixture.stats().reads, reads, "the idle card must not poll Mongo");
  } finally { await fixture.cleanup(); }
});

test("opening Bible status redraws when its timed-out background sync finishes without a click", async t => {
  const fixture = createFixture(t, { slowBible: true });
  try {
    await fixture.open();
    await flushBackground();
    assert.match(embedText(fixture.edits.at(-1)), /Before/);
    assert.equal(fixture.stats().releases, 0, "the sync lease stays held while Bible is pending");
    fixture.finishBible();
    await flushBackground();
    assert.match(embedText(fixture.edits.at(-1)), /After/);
    assert.doesNotMatch(embedText(fixture.edits.at(-1)), /Before|still pulling in the background|still syncing/i);
    assert.equal(fixture.stats().gathers, 1);
    assert.equal(fixture.stats().applies, 1);
    assert.equal(fixture.stats().releases, 1);
  } finally { await fixture.cleanup(); }
});

for (const failure of ["gather", "apply"]) {
  test(`Bible ${failure} failure after its budget updates the open card and releases the lease`, async t => {
    const fixture = createFixture(t, { slowBible: true,
      failBibleGather: failure === "gather", failBackgroundApply: failure === "apply" });
    try {
      await fixture.open();
      await flushBackground();
      fixture.finishBible();
      await flushBackground();
      const text = embedText(fixture.edits.at(-1));
      assert.match(text, /Before/);
      assert.ok(text.includes(translate("raid-status.piggyback.failed", "en")));
      assert.ok(!text.includes(translate("raid-status.piggyback.timeout", "en")));
      assert.equal(fixture.stats().releases, 1);
      assert.equal(fixture.stats().failureStamps, failure === "apply" ? 1 : 0);
    } finally { await fixture.cleanup(); }
  });
}

test("opening Bible status also redraws when the initial sync finishes within its budget", async t => {
  const fixture = createFixture(t);
  try {
    await fixture.open();
    await flushBackground();
    assert.match(embedText(fixture.edits.at(-1)), /After/);
    assert.equal(fixture.stats().gathers, 1);
    assert.equal(fixture.stats().releases, 1);
  } finally { await fixture.cleanup(); }
});

test("Bible may finish persistence after the card expires without editing the expired card again", async t => {
  const fixture = createFixture(t, { slowBible: true });
  try {
    await fixture.open();
    await flushBackground();
    await fixture.end();
    const editsAtEnd = fixture.edits.length, readsAtEnd = fixture.stats().reads;
    fixture.finishBible();
    await flushBackground();
    assert.equal(fixture.edits.length, editsAtEnd);
    assert.equal(fixture.stats().reads, readsAtEnd);
    assert.equal(fixture.stats().applies, 1);
    assert.equal(fixture.stats().releases, 1);
  } finally { await fixture.cleanup(); }
});
