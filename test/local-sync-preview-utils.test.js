const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { buildLocalSyncCatalog } = require("../bot/services/local-sync/core/catalog");

async function loadPreviewUtils() {
  const file = path.join(__dirname, "..", "web", "js", "sync", "preview-utils.js");
  const mod = await import(pathToFileURL(file).href);
  mod.setCatalog(buildLocalSyncCatalog());
  return mod;
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

test("preview buckets get class info from backend catalog", async () => {
  const { bucketize } = await loadPreviewUtils();
  const rows = [
    ["Witch of Agony, Serca", "Hard", 1, "Aki", 1, 1000, "204:Aki"],
  ];
  const [bucket] = bucketize(rows);
  assert.equal(bucket.classId, "204");
  assert.equal(bucket.className, "Bard");
  assert.equal(bucket.classIcon, "/sync/class-icons/bard.png");
});

test("preview renders incoming Normal clears as Solo for a stored Solo raid", async () => {
  const { bucketize, buildDiff, buildActionableBucketKeySet } = await loadPreviewUtils();
  const buckets = bucketize([
    ["Armoche, Sentinel of the Abyss", "Normal", 1, "Aki", 1, 1000, ""],
  ]);
  const diff = buildDiff(makeRoster({
    name: "Aki",
    class: "Bard",
    itemLevel: 1700,
    assignedRaids: {
      armoche: {
        modeKey: "solo",
        G1: { completedDate: null, difficulty: "Solo" },
        G2: { completedDate: null, difficulty: "Solo" },
      },
    },
  }), buckets);

  assert.equal(diff[0].characters[0].cells.length, 1);
  const [cell] = diff[0].characters[0].cells;
  assert.equal(cell.raidKey, "armoche");
  assert.equal(cell.modeKey, "solo");
  assert.equal(cell.sourceModeKey, "normal");
  const actionableKeys = buildActionableBucketKeySet(diff);
  assert.equal(actionableKeys.has("aki::armoche::solo"), true);
  assert.equal(actionableKeys.has("aki::armoche::normal"), true);
});

test("preview exposes an explicit LoaLog Solo clear even before the roster stores Solo", async () => {
  const { bucketize, buildDiff, buildActionableBucketKeySet } = await loadPreviewUtils();
  const buckets = bucketize([
    ["Armoche, Sentinel of the Abyss", "Solo", 1, "Aki", 1, 1000, ""],
  ]);
  const diff = buildDiff(makeRoster({
    name: "Aki",
    class: "Bard",
    itemLevel: 1700,
    assignedRaids: {
      armoche: {
        modeKey: "normal",
        G1: { completedDate: null, difficulty: "Normal" },
        G2: { completedDate: null, difficulty: "Normal" },
      },
    },
  }), buckets);

  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].modeKey, "solo");
  const [cell] = diff[0].characters[0].cells;
  assert.equal(cell.raidKey, "armoche");
  assert.equal(cell.modeKey, "solo");
  assert.equal(cell.sourceModeKey, "solo");
  assert.equal(buildActionableBucketKeySet(diff).has("aki::armoche::solo"), true);
});

test("preview does not treat previous-week progress as a Solo mode conflict", async () => {
  const { bucketize, buildDiff, buildActionableBucketKeySet, collectDiffStateCounts } = await loadPreviewUtils();
  const buckets = bucketize([
    ["Armoche, Sentinel of the Abyss", "Solo", 1, "Aki", 1, 2000, ""],
  ]);
  const diff = buildDiff(makeRoster({
    name: "Aki",
    class: "Bard",
    itemLevel: 1700,
    assignedRaids: {
      armoche: {
        modeKey: "normal",
        G1: { completedDate: 500, difficulty: "Normal" },
        G2: { completedDate: null, difficulty: "Normal" },
      },
    },
  }), buckets, {
    allowedModeKeys: ["solo"],
    currentWeekStartMs: 1000,
  });

  const counts = collectDiffStateCounts(diff);
  assert.equal(counts["mode-conflict"], undefined);
  assert.equal(counts.pending, 2, "Armoche exposes two pending Solo gates");
  assert.equal(
    buildActionableBucketKeySet(diff, { includeModeConflict: false }).has("aki::armoche::solo"),
    true
  );
});

test("preview Solo scope excludes every non-Solo mode from both projections", async () => {
  const { bucketize, buildDiff } = await loadPreviewUtils();
  const buckets = bucketize([
    ["Armoche, Sentinel of the Abyss", "Solo", 1, "Aki", 1, 1000, ""],
    ["Armoche, Sentinel of the Abyss", "Hard", 1, "Aki", 1, 1100, ""],
  ]);
  const diff = buildDiff(makeRoster({
    name: "Aki",
    class: "Bard",
    itemLevel: 1800,
    assignedRaids: {},
  }), buckets, { allowedModeKeys: ["solo"] });

  assert.deepEqual(diff[0].characters[0].cells.map((cell) => cell.modeKey), ["solo"]);
  assert.deepEqual(diff[0].raidCards.map((card) => card.modeKey), ["solo"]);
});

test("preview skips unknown difficulty and Solo on the level-based Horizon raid", async () => {
  const { bucketize } = await loadPreviewUtils();
  assert.deepEqual(bucketize([
    ["Armoche, Sentinel of the Abyss", "", 1, "Aki", 1, 1000, ""],
    ["Armoche, Sentinel of the Abyss", "Mystery", 1, "Aki", 1, 1000, ""],
    ["Archbishop Arcenos", "Solo", 1, "Aki", 1, 1000, ""],
  ]), []);
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
