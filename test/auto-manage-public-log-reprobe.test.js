process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAutoManageCoreService } = require("../bot/services/auto-manage/core");
const {
  UI,
  normalizeName,
  toModeLabel,
  getCharacterName,
  getCharacterClass,
} = require("../bot/utils/raid/common/shared");
const { getRaidGateForBoss, getGatesForRaid } = require("../bot/models/Raid");
const {
  ensureAssignedRaids,
  normalizeAssignedRaid,
  RAID_REQUIREMENT_MAP,
} = require("../bot/utils/raid/common/character");

const HOUR_MS = 60 * 60 * 1000;
const REPROBE_MS = 24 * HOUR_MS;

function makeService(overrides = {}) {
  // Stub bibleLimiter.run so no real HTTP fires: every wrapped call resolves
  // to an empty array (no log entries since week reset). The gather still
  // walks the jobs list and stamps `entry.logs = []`, which is enough to
  // assert which chars produced jobs and which were skipped.
  const bibleLimiter = { run: async () => [] };
  return createAutoManageCoreService({
    EmbedBuilder: class {},
    UI,
    User: { findOne: () => ({ lean: async () => null }) },
    saveWithRetry: async (op) => op(),
    ensureFreshWeek: () => false,
    normalizeName,
    toModeLabel,
    getCharacterName,
    getCharacterClass,
    fetchRosterCharacters: async () => [],
    buildFetchedRosterIndexes: () => ({}),
    findFetchedRosterMatchForCharacter: () => null,
    getRaidGateForBoss,
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    normalizeAssignedRaid,
    ensureAssignedRaids,
    bibleLimiter,
    ...overrides,
  });
}

function makeChar(overrides = {}) {
  // Cached meta lets the gather skip resolveBibleMetaForEntry, which would
  // otherwise call into rosterFetch / SSR scrape paths the test does not
  // stub. We only want to exercise the gather's job-build filter here.
  return {
    name: "Aki",
    class: "Artist",
    itemLevel: 1750,
    bibleSerial: "200000000000000",
    bibleCid: 1,
    bibleRid: 100,
    publicLogDisabled: false,
    publicLogDisabledAt: null,
    ...overrides,
  };
}

function makeDoc(chars) {
  return {
    accounts: [
      {
        accountName: "Roster",
        characters: chars,
      },
    ],
  };
}

test("gather skips chars flagged publicLogDisabled within the reprobe window", async () => {
  const service = makeService();
  const flaggedRecently = new Date(Date.now() - HOUR_MS); // 1h ago
  const doc = makeDoc([
    makeChar({ name: "Aki" }),
    makeChar({
      name: "Bori",
      publicLogDisabled: true,
      publicLogDisabledAt: flaggedRecently,
    }),
  ]);

  const entries = await service.gatherAutoManageLogsForUserDoc(doc, 0);

  // Only Aki should produce a gather entry; Bori is suppressed by the
  // reprobe gate until 24h have elapsed since the flag stamp.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].charName, "Aki");
});

test("gather re-probes a flagged char once the 24h reprobe window expires", async () => {
  const service = makeService();
  const flaggedLongAgo = new Date(Date.now() - (REPROBE_MS + HOUR_MS));
  const doc = makeDoc([
    makeChar({
      name: "Bori",
      publicLogDisabled: true,
      publicLogDisabledAt: flaggedLongAgo,
    }),
  ]);

  const entries = await service.gatherAutoManageLogsForUserDoc(doc, 0);

  // Window expired -> char is probed again so a manual public-log flip
  // gets detected without operator intervention.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].charName, "Bori");
});

test("gather still probes a flagged char when includeEntryKeys targets it explicitly", async () => {
  const service = makeService();
  const flaggedRecently = new Date(Date.now() - HOUR_MS);
  const doc = makeDoc([
    makeChar({
      name: "Bori",
      publicLogDisabled: true,
      publicLogDisabledAt: flaggedRecently,
    }),
  ]);
  const entryKey = service.autoManageEntryKey("Roster", "Bori");

  const entries = await service.gatherAutoManageLogsForUserDoc(doc, 0, {
    includeEntryKeys: [entryKey],
  });

  // Explicit caller selects (probe path, manual retries) override the
  // reprobe gate; the caller is asking specifically for this char.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].charName, "Bori");
});

test("apply stamps publicLogDisabledAt when bible returns Logs not enabled", () => {
  const service = makeService();
  const doc = makeDoc([
    makeChar({ name: "Bori", publicLogDisabled: false, publicLogDisabledAt: null }),
  ]);

  service.applyAutoManageCollected(doc, 0, [
    {
      entryKey: service.autoManageEntryKey("Roster", "Bori"),
      accountName: "Roster",
      charName: "Bori",
      error: "Bible logs API returned HTTP 403 - {\"error\":\"Logs not enabled\"}",
    },
  ]);

  const char = doc.accounts[0].characters[0];
  assert.equal(char.publicLogDisabled, true);
  assert.ok(char.publicLogDisabledAt instanceof Date);
  assert.ok(Date.now() - char.publicLogDisabledAt.getTime() < 5 * 1000);
});

test("apply clears publicLogDisabledAt on the next successful sync", () => {
  const service = makeService();
  const doc = makeDoc([
    makeChar({
      name: "Bori",
      publicLogDisabled: true,
      publicLogDisabledAt: new Date(Date.now() - HOUR_MS),
    }),
  ]);

  service.applyAutoManageCollected(doc, 0, [
    {
      entryKey: service.autoManageEntryKey("Roster", "Bori"),
      accountName: "Roster",
      charName: "Bori",
      logs: [],
    },
  ]);

  const char = doc.accounts[0].characters[0];
  assert.equal(char.publicLogDisabled, false);
  assert.equal(char.publicLogDisabledAt, null);
});
