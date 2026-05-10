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
    isGoldEarner: true,
    assignedRaids: {
      kazeros: {
        G1: { difficulty: "Hard", completedDate: 111 },
        G2: { difficulty: "Hard", completedDate: null },
      },
    },
  }), []);

  assert.deepEqual(summary.completion, {
    totalGates: 2,
    cleared: 1,
    projected: 1,
    percent: 50,
    projectedPercent: 50,
  });
  assert.deepEqual(summary.pendingPostSync, [
    {
      charName: "Aki",
      className: "Artist",
      raidKey: "kazeros",
      modeKey: "hard",
      gates: ["G2"],
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
    isGoldEarner: true,
    assignedRaids: {
      serca: {
        G1: { difficulty: "Hard", completedDate: 111 },
        G2: { difficulty: "Hard", completedDate: null },
      },
    },
  }), buckets);

  assert.deepEqual(summary.completion, {
    totalGates: 2,
    cleared: 1,
    projected: 1,
    percent: 50,
    projectedPercent: 50,
  });
  assert.equal(summary.goldDelta.total, 21000);
  assert.deepEqual(summary.pendingPostSync, [
    {
      charName: "Aki",
      className: "Artist",
      raidKey: "serca",
      modeKey: "nightmare",
      gates: ["G2"],
    },
  ]);
});
