const test = require("node:test");
const assert = require("node:assert/strict");

const { __test, parseRaidMessage } = require("../src/raid-command");
const { ensureFreshWeek, getTargetResetKey } = require("../src/weekly-reset");

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
            lastRefreshAttemptAt: 6789,
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
  assert.equal(snapshot.rosterRefreshAttemptMap.get("user-1\x1fMain"), 6789);
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

test("raid-check user query filters by raid floor while preserving stale refresh candidates", () => {
  const now = Date.UTC(2026, 3, 23, 10, 0, 0, 0);
  const query = __test.buildRaidCheckUserQuery(
    {
      raidKey: "kazeros",
      modeKey: "hard",
      minItemLevel: 1730,
    },
    now
  );

  assert.deepEqual(query, {
    "accounts.0": { $exists: true },
    $or: [
      { "accounts.characters.itemLevel": { $gte: 1710 } },
      {
        accounts: {
          $elemMatch: {
            $and: [
              {
                $or: [
                  { lastRefreshedAt: null },
                  { lastRefreshedAt: { $exists: false } },
                  {
                    lastRefreshedAt: {
                      $lt: now - __test.ROSTER_REFRESH_COOLDOWN_MS,
                    },
                  },
                ],
              },
              {
                $or: [
                  { lastRefreshAttemptAt: null },
                  { lastRefreshAttemptAt: { $exists: false } },
                  {
                    lastRefreshAttemptAt: {
                      $lt: now - __test.ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  });
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

test("parseRaidMessage accepts short kaz hm text-channel format", () => {
  const parsed = parseRaidMessage("kaz hm cyrano");
  assert.deepEqual(parsed, {
    raidKey: "kazeros",
    modeKey: "hard",
    charNames: ["cyrano"],
    gate: null,
  });
});

test("parseRaidMessage accepts 9m as a nightmare alias", () => {
  const parsed = parseRaidMessage("Serca 9m Clauseduk");
  assert.deepEqual(parsed, {
    raidKey: "serca",
    modeKey: "nightmare",
    charNames: ["clauseduk"],
    gate: null,
  });
});

test("stale roster refresh canonicalizes diacritic-only bible character names", () => {
  const userDoc = {
    accounts: [
      {
        accountName: "Cruelfighter",
        lastRefreshedAt: 0,
        lastRefreshAttemptAt: 0,
        characters: [
          {
            name: "Lastdance",
            class: "Wardancer",
            itemLevel: 1700,
            combatScore: "",
            bibleSerial: "old",
            bibleCid: 1,
            bibleRid: 2,
            assignedRaids: { armoche: {}, kazeros: {}, serca: {} },
            tasks: [],
          },
        ],
      },
    ],
  };

  const didUpdate = __test.applyStaleAccountRefreshes(userDoc, [
    {
      accountName: "Cruelfighter",
      resolvedSeed: null,
      attempted: true,
      fetchedChars: [
        {
          charName: "Lastdanc\u00eb",
          className: "Wardancer",
          itemLevel: 1700.8334,
          combatScore: "1861.7",
        },
      ],
    },
  ]);

  const character = userDoc.accounts[0].characters[0];
  assert.equal(didUpdate, true);
  assert.equal(character.name, "Lastdanc\u00eb");
  assert.equal(character.itemLevel, 1700.8334);
  assert.equal(character.class, "Wardancer");
  assert.equal(character.bibleSerial, null);
  assert.equal(character.bibleCid, null);
  assert.equal(character.bibleRid, null);
  assert.ok(userDoc.accounts[0].lastRefreshedAt > 0);
});

test("formatNextCooldownRemaining rounds up and returns null when expired", () => {
  const now = Date.now();
  // Expired (was 10 min ago, cooldown 5 min) -> null so caller can swap
  // in a "ready" marker.
  assert.equal(
    __test.formatNextCooldownRemaining(now - 10 * 60_000, 5 * 60_000),
    null
  );
  // Exactly 0 (edge of boundary) -> null so we never show "0s".
  assert.equal(__test.formatNextCooldownRemaining(now, 0), null);
  // Never attempted (lastAttemptAt = 0) -> null.
  assert.equal(__test.formatNextCooldownRemaining(0, 5 * 60_000), null);
  // 61s remaining -> "2m" (round up, not "1m") so user doesn't press too early.
  const rem61s = __test.formatNextCooldownRemaining(now - 4 * 60_000 + 1_000, 5 * 60_000);
  assert.equal(rem61s, "2m");
  // Sub-minute remaining -> seconds.
  const rem30s = __test.formatNextCooldownRemaining(now - 4 * 60_000 - 30_000, 5 * 60_000);
  assert.match(rem30s, /^\d+s$/);
  // Hours+minutes compact.
  const rem90m = __test.formatNextCooldownRemaining(now - 30 * 60_000, 2 * 60 * 60_000);
  assert.equal(rem90m, "1h30m");
});

test("buildAccountFreshnessLine renders both refresh and sync badges with countdown state", () => {
  const now = Date.now();
  const account = { lastRefreshedAt: now - 30 * 60_000 }; // 30 min ago -> 2h cooldown still active
  const userMeta = {
    autoManageEnabled: true,
    lastAutoManageSyncAt: now - 3 * 60_000, // 3 min ago
    lastAutoManageAttemptAt: now - 3 * 60_000, // cooldown still active (15m)
  };
  const line = __test.buildAccountFreshnessLine(account, userMeta);
  assert.match(line, /Last updated 30m ago/);
  assert.match(line, /Next refresh in 1h30m/);
  assert.match(line, /Last synced 3m ago/);
  assert.match(line, /Next sync in 12m/);
});

test("buildAccountFreshnessLine shows ready marker when cooldown expired", () => {
  const now = Date.now();
  const account = { lastRefreshedAt: now - 3 * 60 * 60_000 }; // 3h ago -> expired
  const userMeta = {
    autoManageEnabled: true,
    lastAutoManageSyncAt: now - 30 * 60_000, // 30m ago
    lastAutoManageAttemptAt: now - 30 * 60_000, // 15m cooldown expired
  };
  const line = __test.buildAccountFreshnessLine(account, userMeta);
  assert.match(line, /Refresh ready/);
  assert.match(line, /Sync ready/);
});

test("buildAccountFreshnessLine honors short refresh failure cooldown", () => {
  const now = Date.now();
  const account = {
    lastRefreshedAt: now - 3 * 60 * 60_000, // success cooldown expired
    lastRefreshAttemptAt: now - 2 * 60_000, // but a failed attempt is still cooling down
  };
  const line = __test.buildAccountFreshnessLine(account, { autoManageEnabled: false });
  assert.match(line, /Last updated 3h ago/);
  assert.match(line, /Next refresh in 3m/);
  assert.doesNotMatch(line, /Refresh ready/);
});

test("buildAccountFreshnessLine omits sync badge when auto-manage is off", () => {
  const account = { lastRefreshedAt: Date.now() - 60_000 };
  const line = __test.buildAccountFreshnessLine(account, { autoManageEnabled: false });
  assert.match(line, /Last updated/);
  assert.doesNotMatch(line, /synced/);
  assert.doesNotMatch(line, /Sync/);
});

test("ensureFreshWeek preserves gate clears already inside the current reset window", () => {
  const now = new Date(Date.UTC(2026, 3, 23, 8, 0, 0, 0)); // Thu Apr 23 2026, after Wed 10:00 UTC reset
  const currentWeekClear = Date.UTC(2026, 3, 23, 6, 59, 11, 61);
  const previousWeekClear = Date.UTC(2026, 3, 22, 9, 59, 59, 999);
  const userDoc = {
    weeklyResetKey: "2026-W16",
    accounts: [
      {
        characters: [
          {
            assignedRaids: {
              armoche: {
                G1: { difficulty: "Normal", completedDate: currentWeekClear },
                G2: { difficulty: "Normal", completedDate: previousWeekClear },
              },
              kazeros: {},
              serca: {},
            },
            tasks: [
              { id: "current-task", completions: 1, completionDate: currentWeekClear },
              { id: "old-task", completions: 1, completionDate: previousWeekClear },
            ],
          },
        ],
      },
    ],
  };

  const changed = ensureFreshWeek(userDoc, now);
  const character = userDoc.accounts[0].characters[0];

  assert.equal(changed, true);
  assert.equal(userDoc.weeklyResetKey, getTargetResetKey(now));
  assert.equal(character.assignedRaids.armoche.G1.completedDate, currentWeekClear);
  assert.equal(character.assignedRaids.armoche.G2.completedDate, null);
  assert.equal(character.tasks[0].completions, 1);
  assert.equal(character.tasks[0].completionDate, currentWeekClear);
  assert.equal(character.tasks[1].completions, 0);
  assert.equal(character.tasks[1].completionDate, null);
});
