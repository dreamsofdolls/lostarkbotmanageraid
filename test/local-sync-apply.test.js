// Phase 4 (2026-05-10): cover the apply pipeline that maps web-companion
// deltas → applyRaidSetForDiscordId calls. Pure unit tests with stubs;
// the integration boundary (real Mongo write, real raid-set retry) is
// already covered by the raid-set test suite.

process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyLocalSyncDeltas,
  resolveLocalSyncTarget,
  bucketizeLocalSyncDeltas,
  normalizeLocalSyncDifficulty,
} = require("../bot/services/local-sync");
const { getRaidRequirementMap } = require("../bot/models/Raid");

function makeApplyStub(impl) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (typeof impl === "function") return impl(args);
    return { matched: true, updated: true };
  };
  fn.calls = calls;
  return fn;
}

function makeUserDoc(chars = []) {
  return {
    accounts: [
      {
        accountName: "Roster",
        characters: chars,
      },
    ],
  };
}

function makeDeps(applyStub, extra = {}) {
  return {
    applyRaidSetForDiscordId: applyStub,
    getRaidRequirementMap,
    currentWeekStartMs: 0,
    ...extra,
  };
}

// ---------- normalizeDifficulty ----------

test("normalizeLocalSyncDifficulty - common variants map to internal modeKey", () => {
  assert.equal(normalizeLocalSyncDifficulty("Normal"), "normal");
  assert.equal(normalizeLocalSyncDifficulty("HARD"), "hard");
  assert.equal(normalizeLocalSyncDifficulty("Trial"), "nightmare");
  assert.equal(normalizeLocalSyncDifficulty("Inferno"), "nightmare");
  assert.equal(normalizeLocalSyncDifficulty("Nightmare"), "nightmare");
});

test("normalizeLocalSyncDifficulty - unknown returns null (caller decides default)", () => {
  assert.equal(normalizeLocalSyncDifficulty("Mystery"), null);
  assert.equal(normalizeLocalSyncDifficulty(""), null);
  assert.equal(normalizeLocalSyncDifficulty(null), null);
});

// ---------- resolveTarget ----------

test("resolveLocalSyncTarget - known boss + difficulty resolves to raidKey/modeKey/gate", () => {
  const t = resolveLocalSyncTarget({ boss: "Armoche, Sentinel of the Abyss", difficulty: "Hard" });
  assert.equal(t.raidKey, "armoche");
  assert.equal(t.modeKey, "hard");
  assert.equal(t.gate, "G2");
});

test("resolveLocalSyncTarget - unknown boss returns null", () => {
  assert.equal(resolveLocalSyncTarget({ boss: "Made-up Boss", difficulty: "Normal" }), null);
});

test("resolveLocalSyncTarget - unknown difficulty falls back to normal", () => {
  const t = resolveLocalSyncTarget({ boss: "Witch of Agony, Serca", difficulty: "Mystery" });
  assert.equal(t.modeKey, "normal");
});

// ---------- bucketize (dedupe + cumulative gate) ----------

test("bucketize - 5 G1 clears + 3 G2 clears for same char+raid+mode -> ONE bucket with G2", () => {
  const deltas = [
    { boss: "Abyss Lord Kazeros", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1000 },
    { boss: "Abyss Lord Kazeros", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 2000 },
    { boss: "Archdemon Kazeros", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 3000 },
  ];
  const buckets = bucketizeLocalSyncDeltas(deltas);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].charName, "Aki");
  assert.equal(buckets[0].raidKey, "kazeros");
  assert.equal(buckets[0].gateIndex, 1); // G2 index in ['G1','G2']
});

test("bucketize - skips !cleared rows", () => {
  const deltas = [
    { boss: "Abyss Lord Kazeros", difficulty: "Normal", cleared: 0, charName: "Aki", lastClearMs: 1000 },
    { boss: "Abyss Lord Kazeros", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 2000 },
  ];
  const buckets = bucketizeLocalSyncDeltas(deltas);
  assert.equal(buckets.length, 1);
});

test("bucketize - different chars produce separate buckets", () => {
  const deltas = [
    { boss: "Abyss Lord Kazeros", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1000 },
    { boss: "Abyss Lord Kazeros", difficulty: "Normal", cleared: 1, charName: "Sora", lastClearMs: 1500 },
  ];
  const buckets = bucketizeLocalSyncDeltas(deltas);
  assert.equal(buckets.length, 2);
});

test("bucketize - char-name match is case-insensitive on the bucket key, preserves original case in output", () => {
  // LOA Logs sometimes capitalizes char names differently across rows
  // (Aki vs aki). Same char should bucket together but the displayed
  // name uses whichever variant came first.
  const deltas = [
    { boss: "Abyss Lord Kazeros", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1000 },
    { boss: "Abyss Lord Kazeros", difficulty: "Normal", cleared: 1, charName: "aki", lastClearMs: 2000 },
  ];
  const buckets = bucketizeLocalSyncDeltas(deltas);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].charName, "Aki");
});

// ---------- applyLocalSyncDeltas ----------

test("applyLocalSyncDeltas - happy path: matched+updated rows go into 'applied'", async () => {
  const applyStub = makeApplyStub(() => ({ matched: true, updated: true, displayName: "Aki" }));
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1 },
  ], makeDeps(applyStub));
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].charName, "Aki");
  assert.equal(result.applied[0].raidKey, "armoche");
  assert.deepEqual(result.applied[0].gates, ["G1"]);
});

test("applyLocalSyncDeltas - cumulative gate expansion: G2 cleared writes [G1, G2]", async () => {
  const applyStub = makeApplyStub(() => ({ matched: true, updated: true }));
  await applyLocalSyncDeltas("u1", [
    { boss: "Armoche, Sentinel of the Abyss", difficulty: "Hard", cleared: 1, charName: "Aki", lastClearMs: 1 },
  ], makeDeps(applyStub));
  // The single G2 delta MUST expand into [G1, G2] in the apply call so
  // the raid card shows fully-cleared, not just the top gate.
  assert.deepEqual(applyStub.calls[0].effectiveGates, ["G1", "G2"]);
  assert.equal(applyStub.calls[0].statusType, "process");
});

test("applyLocalSyncDeltas - write calls can require local-sync to still be enabled", async () => {
  const applyStub = makeApplyStub(() => ({ syncDisabled: true }));
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1 },
  ], makeDeps(applyStub, { requireLocalSyncEnabled: true }));

  assert.equal(applyStub.calls.length, 1);
  assert.equal(applyStub.calls[0].requireLocalSyncEnabled, true);
  assert.equal(result.applied.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "local_sync_disabled");
});

test("applyLocalSyncDeltas - uses batch writer when provided", async () => {
  const applyStub = makeApplyStub(() => {
    throw new Error("single writer should not be called");
  });
  const batchCalls = [];
  const batchStub = async (args) => {
    batchCalls.push(args);
    return args.entries.map((entry) => ({
      matched: true,
      updated: true,
      displayName: entry.characterName,
    }));
  };
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1 },
    { boss: "Abyss Lord Kazeros", difficulty: "Hard", cleared: 1, charName: "Aki", lastClearMs: 2 },
  ], makeDeps(applyStub, {
    applyRaidSetBatchForDiscordId: batchStub,
    requireLocalSyncEnabled: true,
  }));

  assert.equal(applyStub.calls.length, 0);
  assert.equal(batchCalls.length, 1);
  assert.equal(batchCalls[0].requireLocalSyncEnabled, true);
  assert.equal(batchCalls[0].entries.length, 2);
  assert.equal(result.applied.length, 2);
});

test("applyLocalSyncDeltas - unmapped boss bucketed without calling apply", async () => {
  const applyStub = makeApplyStub();
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Phantom Boss", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1 },
  ], makeDeps(applyStub));
  assert.equal(result.unmapped.length, 1);
  assert.equal(result.unmapped[0].boss, "Phantom Boss");
  assert.equal(result.applied.length, 0);
  assert.equal(applyStub.calls.length, 0);
});

test("applyLocalSyncDeltas - rejects clears before the current raid-week reset", async () => {
  const applyStub = makeApplyStub();
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 999 },
  ], makeDeps(applyStub, { currentWeekStartMs: 1000 }));
  assert.equal(result.applied.length, 0);
  assert.equal(result.unmapped.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "outside_current_week");
  assert.equal(applyStub.calls.length, 0);
});

test("applyLocalSyncDeltas - matched but not updated -> 'skipped' (already complete)", async () => {
  const applyStub = makeApplyStub(() => ({ matched: true, updated: false }));
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1 },
  ], makeDeps(applyStub));
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "already_complete");
});

test("applyLocalSyncDeltas - char not in roster -> 'rejected' with reason char_not_in_roster", async () => {
  const applyStub = makeApplyStub(() => ({ matched: false }));
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Stranger", lastClearMs: 1 },
  ], makeDeps(applyStub));
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "char_not_in_roster");
});

test("applyLocalSyncDeltas - roster prefilter rejects unknown chars before write", async () => {
  const applyStub = makeApplyStub();
  const userDoc = makeUserDoc([
    { id: "c1", name: "Aki", class: "Artist", itemLevel: 1750, assignedRaids: {} },
  ]);
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Stranger", lastClearMs: 1 },
  ], makeDeps(applyStub, { userDoc }));
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "char_not_in_roster");
  assert.equal(applyStub.calls.length, 0);
});

test("applyLocalSyncDeltas - roster prefilter skips already-complete gates before write", async () => {
  const applyStub = makeApplyStub();
  const userDoc = makeUserDoc([
    {
      id: "c1",
      name: "Aki",
      class: "Artist",
      itemLevel: 1750,
      assignedRaids: {
        armoche: {
          G1: { difficulty: "Normal", completedDate: 1700000000000 },
        },
      },
    },
  ]);
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1 },
  ], makeDeps(applyStub, { userDoc }));
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "already_complete");
  assert.equal(applyStub.calls.length, 0);
});

test("applyLocalSyncDeltas - roster prefilter still writes eligible incomplete gates", async () => {
  const applyStub = makeApplyStub(() => ({ matched: true, updated: true, displayName: "Aki" }));
  const userDoc = makeUserDoc([
    { id: "c1", name: "Aki", class: "Artist", itemLevel: 1750, assignedRaids: {} },
  ]);
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1 },
  ], makeDeps(applyStub, { userDoc }));
  assert.equal(result.applied.length, 1);
  assert.equal(applyStub.calls.length, 1);
});

test("applyLocalSyncDeltas - ineligibleItemLevel surfaces in 'rejected' with reason ilvl_too_low", async () => {
  const applyStub = makeApplyStub(() => ({ matched: true, updated: false, ineligibleItemLevel: 1650 }));
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Armoche, Sentinel of the Abyss", difficulty: "Hard", cleared: 1, charName: "Aki", lastClearMs: 1 },
  ], makeDeps(applyStub));
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "ilvl_too_low");
  assert.equal(result.rejected[0].ineligibleItemLevel, 1650);
});

test("applyLocalSyncDeltas - apply throw -> rejected with reason write_error", async () => {
  const applyStub = makeApplyStub(() => {
    throw new Error("mongo offline");
  });
  const result = await applyLocalSyncDeltas("u1", [
    { boss: "Brelshaza, Ember in the Ashes", difficulty: "Normal", cleared: 1, charName: "Aki", lastClearMs: 1 },
  ], makeDeps(applyStub));
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "write_error");
});

test("applyLocalSyncDeltas - throws when deps missing", async () => {
  await assert.rejects(
    applyLocalSyncDeltas("u1", [], {}),
    /applyRaidSetForDiscordId required/
  );
  await assert.rejects(
    applyLocalSyncDeltas("u1", [], { applyRaidSetForDiscordId: () => {} }),
    /getRaidRequirementMap required/
  );
});
