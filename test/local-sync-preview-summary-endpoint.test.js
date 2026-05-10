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
    totalRaids: 3,
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
        { raidKey: "armoche", modeKey: "hard", status: "pending", incoming: false },
        { raidKey: "kazeros", modeKey: "hard", status: "partial", incoming: false },
        { raidKey: "serca", modeKey: "nightmare", status: "pending", incoming: false },
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
    totalRaids: 3,
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
        { raidKey: "armoche", modeKey: "hard", status: "pending", incoming: false },
        { raidKey: "kazeros", modeKey: "hard", status: "pending", incoming: false },
        { raidKey: "serca", modeKey: "nightmare", status: "partial", incoming: true },
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
    totalRaids: 3,
    cleared: 0,
    projected: 1,
    percent: 0,
    projectedPercent: 33,
  });
  // Gold credits BOTH gates (Kazeros Hard: G1=17000 + G2=35000) even
  // though only G2 was in the file - this is what we want, otherwise
  // mid-raid log-enable users get cheated out of G1 gold.
  assert.equal(summary.goldDelta.total, 52000);
  // The completed incoming raid stays visible because the same character
  // still has other eligible raids pending after sync.
  assert.deepEqual(summary.charsAfterSync, [
    {
      accountName: "Roster",
      charName: "Aki",
      className: "Artist",
      itemLevel: 1750,
      raids: [
        { raidKey: "armoche", modeKey: "hard", status: "pending", incoming: false },
        { raidKey: "kazeros", modeKey: "hard", status: "done", incoming: true },
        { raidKey: "serca", modeKey: "nightmare", status: "pending", incoming: false },
      ],
    },
  ]);
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
    totalRaids: 3,
    cleared: 1,
    projected: 1,
    percent: 33,
    projectedPercent: 33,
  });
  // The character still has other eligible raids pending, so it remains
  // in charsAfterSync with the completed raid shown as done.
  assert.deepEqual(summary.charsAfterSync, [
    {
      accountName: "Roster",
      charName: "Aki",
      className: "Artist",
      itemLevel: 1750,
      raids: [
        { raidKey: "armoche", modeKey: "hard", status: "done", incoming: false },
        { raidKey: "kazeros", modeKey: "hard", status: "pending", incoming: false },
        { raidKey: "serca", modeKey: "nightmare", status: "pending", incoming: false },
      ],
    },
  ]);
});

test("preview summary keeps fully done sync chars visible beside gold", () => {
  const buckets = bucketizeLocalSyncDeltas([
    {
      boss: "Corvus Tul Rak", // Serca G2 Hard; cumulative rule implies G1 too.
      difficulty: "Hard",
      cleared: true,
      charName: "Aki",
      lastClearMs: 12345,
    },
  ]);

  const summary = projectSummary(makeAccounts({
    name: "Aki",
    class: "Artist",
    itemLevel: 1735,
    isGoldEarner: true,
    assignedRaids: {
      armoche: {
        G1: { difficulty: "Hard", completedDate: 111 },
        G2: { difficulty: "Hard", completedDate: 222 },
      },
      kazeros: {
        G1: { difficulty: "Hard", completedDate: 333 },
        G2: { difficulty: "Hard", completedDate: 444 },
      },
      serca: {
        G1: { difficulty: "Hard", completedDate: null },
        G2: { difficulty: "Hard", completedDate: null },
      },
    },
  }), buckets);

  assert.deepEqual(summary.completion, {
    totalRaids: 3,
    cleared: 2,
    projected: 3,
    percent: 67,
    projectedPercent: 100,
  });
  assert.equal(summary.goldDelta.total, 44000);
  assert.deepEqual(summary.charsAfterSync, [
    {
      accountName: "Roster",
      charName: "Aki",
      className: "Artist",
      itemLevel: 1735,
      raids: [
        { raidKey: "armoche", modeKey: "hard", status: "done", incoming: false },
        { raidKey: "kazeros", modeKey: "hard", status: "done", incoming: false },
        { raidKey: "serca", modeKey: "hard", status: "done", incoming: true },
      ],
    },
  ]);
  assert.deepEqual(summary.goldDelta.byChar, [
    {
      accountName: "Roster",
      charName: "Aki",
      className: "Artist",
      itemLevel: 1735,
      gold: 44000,
    },
  ]);
});

test("preview summary includes eligible chars with no assigned raid state", () => {
  const summary = projectSummary(makeAccounts({
    name: "Qyoir",
    class: "Artist",
    itemLevel: 1710,
    isGoldEarner: true,
    assignedRaids: {},
  }), []);

  assert.deepEqual(summary.completion, {
    totalRaids: 3,
    cleared: 0,
    projected: 0,
    percent: 0,
    projectedPercent: 0,
  });
  assert.deepEqual(summary.charsAfterSync, [
    {
      accountName: "Roster",
      charName: "Qyoir",
      className: "Artist",
      itemLevel: 1710,
      raids: [
        { raidKey: "armoche", modeKey: "normal", status: "pending", incoming: false },
        { raidKey: "kazeros", modeKey: "normal", status: "pending", incoming: false },
        { raidKey: "serca", modeKey: "normal", status: "pending", incoming: false },
      ],
    },
  ]);
});
