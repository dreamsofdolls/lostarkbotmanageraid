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
      charName: "Aki",
      className: "Artist",
      itemLevel: 1750,
      raids: [
        { raidKey: "serca", modeKey: "nightmare", status: "partial" },
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
