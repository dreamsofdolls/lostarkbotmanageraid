const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function loadPreviewUtils() {
  const file = path.join(__dirname, "..", "web", "preview-utils.js");
  return import(pathToFileURL(file).href);
}

function makeRoster(character) {
  return [
    {
      accountName: "Roster",
      characters: [character],
    },
  ];
}

test("preview actionable keys include only registered roster clears that are not already synced", async () => {
  const { bucketize, buildDiff, buildActionableBucketKeySet } = await loadPreviewUtils();
  const rows = [
    ["Witch of Agony, Serca", "Hard", 1, "Aki", 1, 1000, ""],
  ];
  const buckets = bucketize(rows);
  const diff = buildDiff(makeRoster({
    name: "Aki",
    class: "Bard",
    itemLevel: 1740,
    assignedRaids: {},
  }), buckets);

  const keys = buildActionableBucketKeySet(diff);
  assert.equal(keys.size, 1);
  assert.equal(keys.has("aki::serca::hard"), true);
});

test("preview actionable keys exclude off-roster clears", async () => {
  const { bucketize, buildDiff, buildActionableBucketKeySet } = await loadPreviewUtils();
  const rows = [
    ["Witch of Agony, Serca", "Hard", 1, "Unknown", 1, 1000, ""],
  ];
  const buckets = bucketize(rows);
  const diff = buildDiff(makeRoster({
    name: "Aki",
    class: "Bard",
    itemLevel: 1740,
    assignedRaids: {},
  }), buckets);

  const keys = buildActionableBucketKeySet(diff);
  assert.equal(keys.size, 0);
});

test("preview actionable keys exclude clears that are already marked complete", async () => {
  const { bucketize, buildDiff, buildActionableBucketKeySet, collectDiffStateCounts } = await loadPreviewUtils();
  const rows = [
    ["Witch of Agony, Serca", "Hard", 1, "Aki", 1, 1000, ""],
  ];
  const buckets = bucketize(rows);
  const diff = buildDiff(makeRoster({
    name: "Aki",
    class: "Bard",
    itemLevel: 1740,
    assignedRaids: {
      serca: {
        G1: { completedDate: 1, difficulty: "hard" },
      },
    },
  }), buckets);

  const keys = buildActionableBucketKeySet(diff);
  assert.equal(keys.size, 0);
  assert.equal(collectDiffStateCounts(diff).synced, 1);
  assert.equal(collectDiffStateCounts(diff).pending, undefined);
});

test("currentWeeklyResetStartMs follows Wednesday 17:00 VN reset boundary", async () => {
  const { currentWeeklyResetStartMs } = await loadPreviewUtils();
  assert.equal(
    currentWeeklyResetStartMs(new Date(Date.UTC(2026, 3, 22, 9, 59, 0, 0))),
    Date.UTC(2026, 3, 15, 10, 0, 0, 0)
  );
  assert.equal(
    currentWeeklyResetStartMs(new Date(Date.UTC(2026, 3, 22, 10, 0, 0, 0))),
    Date.UTC(2026, 3, 22, 10, 0, 0, 0)
  );
  assert.equal(
    currentWeeklyResetStartMs(new Date(Date.UTC(2026, 3, 26, 12, 0, 0, 0))),
    Date.UTC(2026, 3, 22, 10, 0, 0, 0)
  );
});
