process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const test = require("node:test");
const assert = require("node:assert/strict");

const { bucketizeLocalSyncDeltas } = require("../bot/services/local-sync");
const { projectSummary } = require("../bot/services/local-sync/preview-summary-endpoint");

function makeAccounts(character) {
  return [
    {
      accountName: "Roster",
      characters: [character],
    },
  ];
}

test("preview summary reads assigned raid difficulty from gate entries", () => {
  const summary = projectSummary(makeAccounts({
    name: "Aki",
    class: "Artist",
    itemLevel: 1750,
    isGoldEarner: true,
    assignedRaids: {
      kazeros: {
        G1: { difficulty: "Hard", completedDate: 111 },
        G2: { difficulty: "Hard", completedDate: null },
      },
    },
  }), []);

  assert.deepEqual(summary.completion, {
    totalRaids: 1,
    cleared: 0,
    projected: 0,
    percent: 0,
    projectedPercent: 0,
  });
  assert.deepEqual(summary.charsAfterSync, [
    {
      accountName: "Roster",
      charName: "Aki",
      className: "Artist",
      itemLevel: 1750,
      raids: [
        { raidKey: "kazeros", modeKey: "hard", status: "partial" },
      ],
    },
  ]);
});

test("preview summary calculates pending gates in the post-sync mode", () => {
  const buckets = bucketizeLocalSyncDeltas([
    {
      boss: "Witch of Agony, Serca",
      difficulty: "Nightmare",
      cleared: true,
      charName: "Aki",
      lastClearMs: 12345,
    },
  ]);

  const summary = projectSummary(makeAccounts({
    name: "Aki",
    class: "Artist",
    itemLevel: 1750,
    isGoldEarner: true,
    assignedRaids: {
      serca: {
        G1: { difficulty: "Hard", completedDate: 111 },
        G2: { difficulty: "Hard", completedDate: null },
      },
    },
  }), buckets);

  // Pre-sync: serca Hard has 1/2 gates cleared - NOT a completed raid.
  // Post-sync: cross-mode delta resets serca to Nightmare; only G1 cleared
  // there - still NOT a completed raid. So both percent and projected
  // percent stay at 0%.
  assert.deepEqual(summary.completion, {
    totalRaids: 1,
    cleared: 0,
    projected: 0,
    percent: 0,
    projectedPercent: 0,
  });
  assert.equal(summary.goldDelta.total, 21000);
  assert.deepEqual(summary.charsAfterSync, [
    {
      accountName: "Roster",
      charName: "Aki",
      className: "Artist",
      itemLevel: 1750,
      raids: [
        { raidKey: "serca", modeKey: "nightmare", status: "partial" },
      ],
    },
  ]);
});

test("preview summary expands cumulative gates when only later gate is logged (LOA Logs enabled mid-raid)", () => {
  // Real-world scenario: user clears G1 with LOA Logs disabled, then
  // enables Logs and clears G2. encounters.db only has the G2 row.
  // Cumulative-gate semantics rescues this: a G2 clear is in-game proof
  // G1 was cleared too (LA gates are strictly sequential per week), so
  // the projection marks both gates cleared even though only G2 is in
  // the delta stream.
  const buckets = bucketizeLocalSyncDeltas([
    {
      boss: "Death Incarnate Kazeros", // G2 Hard
      difficulty: "Hard",
      cleared: true,
      charName: "Aki",
      lastClearMs: 12345,
    },
  ]);

  const summary = projectSummary(makeAccounts({
    name: "Aki",
    class: "Artist",
    itemLevel: 1750,
    isGoldEarner: true,
    assignedRaids: {
      kazeros: {
        G1: { difficulty: "Hard", completedDate: null },
        G2: { difficulty: "Hard", completedDate: null },
      },
    },
  }), buckets);

  // Pre-sync: nothing cleared. Post-sync: kazeros fully cleared via the
  // G2-implies-G1 cumulative rule.
  assert.deepEqual(summary.completion, {
    totalRaids: 1,
    cleared: 0,
    projected: 1,
    percent: 0,
    projectedPercent: 100,
  });
  // Gold credits BOTH gates (Kazeros Hard: G1=17000 + G2=35000) even
  // though only G2 was in the file - this is what we want, otherwise
  // mid-raid log-enable users get cheated out of G1 gold.
  assert.equal(summary.goldDelta.total, 52000);
  // Done char drops out of the pending list - charsAfterSync only
  // surfaces chars with at least one non-done raid post-sync.
  assert.deepEqual(summary.charsAfterSync, []);
});

test("preview summary marks fully-cleared raid as done", () => {
  const summary = projectSummary(makeAccounts({
    name: "Aki",
    class: "Artist",
    itemLevel: 1750,
    isGoldEarner: true,
    assignedRaids: {
      armoche: {
        G1: { difficulty: "Hard", completedDate: 111 },
        G2: { difficulty: "Hard", completedDate: 222 },
      },
    },
  }), []);

  assert.deepEqual(summary.completion, {
    totalRaids: 1,
    cleared: 1,
    projected: 1,
    percent: 100,
    projectedPercent: 100,
  });
  // Done chars are NOT in charsAfterSync - the list focuses on chars
  // with at least one non-done raid post-sync.
  assert.deepEqual(summary.charsAfterSync, []);
});
