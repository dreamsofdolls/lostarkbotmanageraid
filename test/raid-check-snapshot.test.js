const test = require("node:test");
const assert = require("node:assert/strict");

const { __test, parseRaidMessage } = require("../src/raid-command");
const { getTargetResetKey } = require("../src/weekly-reset");

function makeCharacter(name, itemLevel, kazeros = {}) {
  return {
    id: `${name}-id`,
    name,
    class: "Bard",
    itemLevel,
    assignedRaids: {
      armoche: {},
      kazeros,
      serca: {},
    },
    tasks: [],
  };
}

test("buildRaidCheckSnapshotFromUsers keeps roster freshness metadata and counts higher-mode clears for lower-mode scans", () => {
  const snapshot = __test.buildRaidCheckSnapshotFromUsers(
    [
      {
        discordId: "user-1",
        weeklyResetKey: getTargetResetKey(new Date()),
        autoManageEnabled: true,
        lastAutoManageSyncAt: 1234,
        accounts: [
          {
            accountName: "Main",
            lastRefreshedAt: 5678,
            characters: [
              // Both chars sit in Kazeros Normal's eligibility range
              // [1710, 1730). ClearedHard completed Hard -> satisfies the
              // Normal scan via mode hierarchy. StillPending hasn't cleared.
              makeCharacter("ClearedHard", 1720, {
                G1: { difficulty: "Hard", completedDate: 1 },
                G2: { difficulty: "Hard", completedDate: 2 },
              }),
              makeCharacter("StillPending", 1720, {}),
            ],
          },
        ],
      },
    ],
    { raidKey: "kazeros", modeKey: "normal", minItemLevel: 1710 }
  );

  assert.equal(snapshot.completeChars.length, 1);
  assert.equal(snapshot.noneChars.length, 1);
  assert.equal(snapshot.pendingChars.length, 1);
  assert.equal(snapshot.userMeta.get("user-1")?.autoManageEnabled, true);
  assert.equal(snapshot.userMeta.get("user-1")?.lastAutoManageSyncAt, 1234);
  assert.equal(snapshot.rosterRefreshMap.get("user-1\x1fMain"), 5678);
  assert.equal(snapshot.completeChars[0]?.charName, "ClearedHard");
  assert.equal(snapshot.pendingChars[0]?.charName, "StillPending");
});

test("buildRaidCheckSnapshotFromUsers keeps higher-mode clears complete even above the next mode threshold", () => {
  const snapshot = __test.buildRaidCheckSnapshotFromUsers(
    [
      {
        discordId: "user-1",
        weeklyResetKey: getTargetResetKey(new Date()),
        accounts: [
          {
            accountName: "Main",
            characters: [
              makeCharacter("HardDone1740", 1740, {
                G1: { difficulty: "Hard", completedDate: 1 },
                G2: { difficulty: "Hard", completedDate: 2 },
              }),
            ],
          },
        ],
      },
    ],
    { raidKey: "kazeros", modeKey: "normal", minItemLevel: 1710 }
  );

  assert.equal(snapshot.completeChars.length, 1);
  assert.equal(snapshot.completeChars[0]?.charName, "HardDone1740");
  assert.equal(snapshot.notEligibleChars.length, 0);
});

test("buildRaidCheckSnapshotFromUsers marks out-grown chars as not-eligible when scanning a lower mode", () => {
  const snapshot = __test.buildRaidCheckSnapshotFromUsers(
    [
      {
        discordId: "user-1",
        weeklyResetKey: getTargetResetKey(new Date()),
        accounts: [
          {
            accountName: "Main",
            characters: [
              makeCharacter("FitForNormal", 1700, {}), // [1700, 1720) eligible for Act4 Normal
              makeCharacter("AboveNormal", 1725, {}),  // >= 1720, out-grown - should do Hard
              makeCharacter("AboveNormal2", 1740, {}),
            ],
          },
        ],
      },
    ],
    { raidKey: "armoche", modeKey: "normal", minItemLevel: 1700 }
  );

  assert.equal(snapshot.allEligible.length, 1);
  assert.equal(snapshot.notEligibleChars.length, 2);
  assert.equal(snapshot.notEligibleChars[0]?.notEligibleReason, "high");
  assert.equal(snapshot.allChars.length, 3); // combined render set
});

test("buildRaidCheckSnapshotFromUsers marks under-iLvl chars as not-eligible when scanning a higher mode", () => {
  const snapshot = __test.buildRaidCheckSnapshotFromUsers(
    [
      {
        discordId: "user-1",
        weeklyResetKey: getTargetResetKey(new Date()),
        accounts: [
          {
            accountName: "Main",
            characters: [
              makeCharacter("TooLow", 1715, {}),  // [1710, 1730) - below Kazeros Hard
              makeCharacter("JustFit", 1735, {}), // >= 1730 - fits Kazeros Hard
            ],
          },
        ],
      },
    ],
    { raidKey: "kazeros", modeKey: "hard", minItemLevel: 1730 }
  );

  assert.equal(snapshot.allEligible.length, 1);
  assert.equal(snapshot.notEligibleChars.length, 1);
  assert.equal(snapshot.notEligibleChars[0]?.charName, "TooLow");
  assert.equal(snapshot.notEligibleChars[0]?.notEligibleReason, "low");
});

test("buildRaidCheckSnapshotFromUsers keeps done-only rosters visible in the combined render set", () => {
  const snapshot = __test.buildRaidCheckSnapshotFromUsers(
    [
      {
        discordId: "done-user",
        weeklyResetKey: getTargetResetKey(new Date()),
        accounts: [
          {
            accountName: "DoneOnly",
            characters: [
              makeCharacter("AlreadyDone", 1720, {
                G1: { difficulty: "Normal", completedDate: 1 },
                G2: { difficulty: "Normal", completedDate: 2 },
              }),
            ],
          },
        ],
      },
      {
        discordId: "pending-user",
        weeklyResetKey: getTargetResetKey(new Date()),
        accounts: [
          {
            accountName: "PendingRoster",
            characters: [
              makeCharacter("StillPending", 1720, {}),
              makeCharacter("DoneMate", 1720, {
                G1: { difficulty: "Normal", completedDate: 1 },
                G2: { difficulty: "Normal", completedDate: 2 },
              }),
            ],
          },
        ],
      },
    ],
    { raidKey: "kazeros", modeKey: "normal", minItemLevel: 1710 }
  );

  const rosterKeys = [...new Set(snapshot.allChars.map((c) => `${c.discordId}|${c.accountName}`))];
  assert.deepEqual(rosterKeys, ["done-user|DoneOnly", "pending-user|PendingRoster"]);
  assert.equal(snapshot.allChars.length, 3);
});

test("raid-check pagination timeout is 5 minutes while raid-status stays at 2 minutes", () => {
  assert.equal(__test.STATUS_PAGINATION_SESSION_MS, 2 * 60 * 1000);
  assert.equal(__test.RAID_CHECK_PAGINATION_SESSION_MS, 5 * 60 * 1000);
});

test("parseRaidMessage accepts hm as a hard alias", () => {
  const parsed = parseRaidMessage("Kazeros hm Clauseduk");
  assert.deepEqual(parsed, {
    raidKey: "kazeros",
    modeKey: "hard",
    charNames: ["clauseduk"],
    gate: null,
  });
});
