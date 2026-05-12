process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAutoManageCoreService } = require("../bot/services/auto-manage/core");
const { UI, normalizeName, toModeLabel, getCharacterName, getCharacterClass } = require("../bot/utils/raid/common/shared");
const { getRaidGateForBoss, getGatesForRaid } = require("../bot/models/Raid");
const {
  ensureAssignedRaids,
  normalizeAssignedRaid,
  RAID_REQUIREMENT_MAP,
} = require("../bot/utils/raid/common/character");

function makeService() {
  return createAutoManageCoreService({
    EmbedBuilder: class {},
    UI,
    User: {
      findOne: () => ({ lean: async () => null }),
    },
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
    bibleLimiter: { schedule: async (op) => op() },
  });
}

function makeUserDoc(assignedRaids) {
  return {
    accounts: [
      {
        accountName: "Roster",
        characters: [
          {
            name: "Aki",
            class: "Artist",
            itemLevel: 1750,
            assignedRaids,
          },
        ],
      },
    ],
  };
}

test("auto-manage apply keeps existing modeKey when current sync has no clear logs", () => {
  const service = makeService();
  const userDoc = makeUserDoc({
    kazeros: {
      modeKey: "hard",
      G1: { difficulty: "Hard", completedDate: null },
      G2: { difficulty: "Hard", completedDate: null },
    },
  });

  const report = service.applyAutoManageCollected(userDoc, 1000, [
    {
      entryKey: service.autoManageEntryKey("Roster", "Aki"),
      logs: [],
    },
  ]);

  const kaz = userDoc.accounts[0].characters[0].assignedRaids.kazeros;
  assert.equal(report.appliedTotal, 0);
  assert.equal(kaz.modeKey, "hard");
  assert.equal(kaz.G1.difficulty, "Hard");
  assert.equal(kaz.G2.difficulty, "Hard");
});

test("auto-manage apply changes modeKey only when a clear log arrives in the new mode", () => {
  const service = makeService();
  const userDoc = makeUserDoc({
    kazeros: {
      modeKey: "hard",
      G1: { difficulty: "Hard", completedDate: null },
      G2: { difficulty: "Hard", completedDate: null },
    },
  });

  const report = service.applyAutoManageCollected(userDoc, 1000, [
    {
      entryKey: service.autoManageEntryKey("Roster", "Aki"),
      logs: [
        { boss: "Abyss Lord Kazeros", difficulty: "Normal", timestamp: 2000 },
        { boss: "Archdemon Kazeros", difficulty: "Normal", timestamp: 3000 },
      ],
    },
  ]);

  const kaz = userDoc.accounts[0].characters[0].assignedRaids.kazeros;
  assert.equal(report.appliedTotal, 2);
  assert.equal(kaz.modeKey, "normal");
  assert.equal(kaz.G1.difficulty, "Normal");
  assert.equal(kaz.G2.difficulty, "Normal");
  assert.equal(kaz.G1.completedDate, 2000);
  assert.equal(kaz.G2.completedDate, 3000);
});
