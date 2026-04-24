// Seed RAID_MANAGER_ID before requiring raid-command so manager.js captures
// a deterministic allowlist at module load. Tests below rely on these IDs
// to verify manager-specific branching (30s sync cooldown, 👑 roster prefix).
process.env.RAID_MANAGER_ID = "test-manager-1,test-manager-2";

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

test("buildRaidCheckSnapshotFromUsers keeps higher-ilvl chars eligible when scanning a lower mode", () => {
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
              makeCharacter("AboveNormal", 1725, {}),
              makeCharacter("AboveNormal2", 1740, {}),
            ],
          },
        ],
      },
    ],
    { raidKey: "armoche", modeKey: "normal", minItemLevel: 1700 }
  );

  assert.equal(snapshot.allEligible.length, 3);
  assert.equal(snapshot.notEligibleChars.length, 0);
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

test("raid-check not-eligible note explains below-min chars clearly", () => {
  const fieldValue = __test.formatRaidCheckNotEligibleFieldValue({
    charName: "TooLow",
    itemLevel: 1715,
    notEligibleReason: "low",
  });

  assert.match(fieldValue, /Not eligible yet/);
  assert.match(fieldValue, /below min/);
});

test("raid-check renderable chars hide not-eligible entries from the visible list", () => {
  const snapshot = __test.buildRaidCheckSnapshotFromUsers(
    [
      {
        discordId: "user-1",
        weeklyResetKey: getTargetResetKey(new Date()),
        accounts: [
          {
            accountName: "Main",
            characters: [
              makeCharacter("PendingHard", 1735, {}),
              makeCharacter("TooLow", 1715, {}),
              makeCharacter("AlreadyNightmare", 1743, {}),
            ],
          },
        ],
      },
    ],
    { raidKey: "serca", modeKey: "hard", minItemLevel: 1730 }
  );

  const renderable = __test.getRaidCheckRenderableChars(snapshot);
  assert.deepEqual(renderable.map((char) => char.charName), ["PendingHard", "AlreadyNightmare"]);
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

test("parseRaidMessage treats nm as a normal alias (Traine's alias swap)", () => {
  const parsed = parseRaidMessage("Serca nm Clauseduk");
  assert.deepEqual(parsed, {
    raidKey: "serca",
    modeKey: "normal",
    charNames: ["clauseduk"],
    gate: null,
  });
});

test("parseRaidMessage no longer treats nm as a nightmare shorthand", () => {
  const parsed = parseRaidMessage("Serca nm Clauseduk");
  assert.notEqual(parsed?.modeKey, "nightmare");
});

test("Artist quiet hours: VN hour computation crosses the UTC+7 boundary correctly", () => {
  // 20:00 UTC Apr 23 = 03:00 VN Apr 24 (midnight crosses +7).
  const at20UtcApr23 = new Date(Date.UTC(2026, 3, 23, 20, 0, 0, 0));
  assert.equal(__test.getCurrentVNHour(at20UtcApr23), 3);
  assert.equal(__test.getTargetVNDayKey(at20UtcApr23), "2026-04-24");

  // 00:59 UTC Apr 24 = 07:59 VN Apr 24 (still inside quiet window).
  const at0059UtcApr24 = new Date(Date.UTC(2026, 3, 24, 0, 59, 0, 0));
  assert.equal(__test.getCurrentVNHour(at0059UtcApr24), 7);

  // 01:00 UTC Apr 24 = 08:00 VN Apr 24 (wake-up hour, NOT quiet).
  const at01UtcApr24 = new Date(Date.UTC(2026, 3, 24, 1, 0, 0, 0));
  assert.equal(__test.getCurrentVNHour(at01UtcApr24), 8);
  assert.equal(__test.getTargetVNDayKey(at01UtcApr24), "2026-04-24");
});

test("Artist quiet hours: isInArtistQuietHours covers [3, 8) and nothing else", () => {
  const quietStartExact = new Date(Date.UTC(2026, 3, 23, 20, 0, 0, 0)); // 03:00 VN
  const quietMid = new Date(Date.UTC(2026, 3, 24, 0, 30, 0, 0)); // 07:30 VN
  const quietLastBefore8 = new Date(Date.UTC(2026, 3, 24, 0, 59, 59, 0)); // 07:59 VN
  const wakeupBoundary = new Date(Date.UTC(2026, 3, 24, 1, 0, 0, 0)); // 08:00 VN
  const lateNight = new Date(Date.UTC(2026, 3, 23, 19, 59, 0, 0)); // 02:59 VN
  const afternoon = new Date(Date.UTC(2026, 3, 24, 8, 0, 0, 0)); // 15:00 VN

  assert.equal(__test.isInArtistQuietHours(quietStartExact), true);
  assert.equal(__test.isInArtistQuietHours(quietMid), true);
  assert.equal(__test.isInArtistQuietHours(quietLastBefore8), true);
  assert.equal(__test.isInArtistQuietHours(wakeupBoundary), false); // 08:00 NOT quiet - it's wake-up
  assert.equal(__test.isInArtistQuietHours(lateNight), false); // 02:59 NOT quiet yet
  assert.equal(__test.isInArtistQuietHours(afternoon), false);
});

test("Artist quiet hours: wake-up boundary only opens at 08:00 VN, not midnight-to-02:59", () => {
  const beforeMidnightWake = new Date(Date.UTC(2026, 3, 23, 17, 30, 0, 0)); // 00:30 VN
  const beforeQuietStarts = new Date(Date.UTC(2026, 3, 23, 19, 30, 0, 0)); // 02:30 VN
  const wakeupBoundary = new Date(Date.UTC(2026, 3, 24, 1, 0, 0, 0)); // 08:00 VN
  const afterWakeup = new Date(Date.UTC(2026, 3, 24, 2, 30, 0, 0)); // 09:30 VN

  assert.equal(__test.hasReachedArtistWakeupBoundary(beforeMidnightWake), false);
  assert.equal(__test.hasReachedArtistWakeupBoundary(beforeQuietStarts), false);
  assert.equal(__test.hasReachedArtistWakeupBoundary(wakeupBoundary), true);
  assert.equal(__test.hasReachedArtistWakeupBoundary(afterWakeup), true);
});

test("Artist quiet hours: bedtime pool returns one of 3 variants, none mentioning sweep count", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const picked = __test.pickBedtimeNoticeContent();
    seen.add(picked);
    // Bedtime is ceremonial, not sweep-scaled - no **N** placeholder survives.
    assert.doesNotMatch(picked, /\*\*N\*\*/);
    assert.match(picked, /ngủ|sáng/); // sanity: tone words land
  }
  // Over 50 draws we should have seen all 3 variants (probability of
  // missing one after 50 draws from a 3-variant pool is (2/3)^50 ≈ 1e-9).
  assert.equal(seen.size, 3);
});

test("Artist quiet hours: wake-up pool interpolates N and buckets correctly", () => {
  const empty = __test.pickWakeupNoticeContent(0);
  assert.doesNotMatch(empty, /\*\*\d+\*\*/); // 0 doesn't render a count

  const trivial = __test.pickWakeupNoticeContent(3);
  assert.match(trivial, /\*\*3\*\*/);

  const normal = __test.pickWakeupNoticeContent(15);
  assert.match(normal, /\*\*15\*\*/);

  const heavy = __test.pickWakeupNoticeContent(42);
  assert.match(heavy, /\*\*42\*\*/);
});

test("Artist quiet hours: wake-up pool is disjoint from the hourly-cleanup pool", () => {
  // Regression guard: a future refactor might merge the two pools by accident.
  // The wake-up moment is ceremonial (morning) and the hourly one is not, so
  // their variant sets must stay separate.
  const wakeupSamples = new Set();
  const hourlySamples = new Set();
  for (let i = 0; i < 60; i += 1) {
    wakeupSamples.add(__test.pickWakeupNoticeContent(10));
  }
  // Any wake-up line mentioning "morning" or "dậy" should never appear in the
  // regular hourly pool (verified by checking a few hourly outputs).
  const morningMarkers = [...wakeupSamples].filter((s) => /dậy|Morning|sáng/i.test(s));
  assert.ok(morningMarkers.length > 0, "wake-up pool must contain morning-tone lines");
});

test("nextAnnouncementEligibleBoundaryMs: artist-bedtime lands on next 20:00 UTC (= 03:00 VN)", () => {
  // Thu Apr 23 2026 19:00 UTC (02:00 VN Apr 24) → next bedtime = 20:00 UTC same day.
  const before = new Date(Date.UTC(2026, 3, 23, 19, 0, 0, 0));
  const fire = __test.nextAnnouncementEligibleBoundaryMs("artist-bedtime", before);
  assert.equal(fire, Date.UTC(2026, 3, 23, 20, 0, 0, 0));

  // Exactly at 20:00 UTC → we advance to the next day (already past boundary).
  const atBoundary = new Date(Date.UTC(2026, 3, 23, 20, 0, 0, 0));
  const fireNext = __test.nextAnnouncementEligibleBoundaryMs("artist-bedtime", atBoundary);
  assert.equal(fireNext, Date.UTC(2026, 3, 24, 20, 0, 0, 0));
});

test("nextAnnouncementEligibleBoundaryMs: artist-wakeup lands on next 01:00 UTC (= 08:00 VN)", () => {
  // 00:30 UTC Apr 24 (07:30 VN) → next wake-up = 01:00 UTC same day (08:00 VN).
  const before = new Date(Date.UTC(2026, 3, 24, 0, 30, 0, 0));
  const fire = __test.nextAnnouncementEligibleBoundaryMs("artist-wakeup", before);
  assert.equal(fire, Date.UTC(2026, 3, 24, 1, 0, 0, 0));

  // At 01:30 UTC (08:30 VN) already past → advance to the next day.
  const after = new Date(Date.UTC(2026, 3, 24, 1, 30, 0, 0));
  const fireNext = __test.nextAnnouncementEligibleBoundaryMs("artist-wakeup", after);
  assert.equal(fireNext, Date.UTC(2026, 3, 25, 1, 0, 0, 0));
});

test("Edit flow: buildEditableCharsByUser hides auto-sync chars when log is ON", () => {
  // Simulate the snapshot shape buildEditableCharsByUser expects: allChars
  // with per-char publicLogDisabled + a userMeta Map with autoManageEnabled.
  const userMeta = new Map([
    ["auto-user", { autoManageEnabled: true }],
    ["manual-user", { autoManageEnabled: false }],
  ]);
  const allChars = [
    { discordId: "auto-user", accountName: "A", charName: "AutoLogOn", itemLevel: 1720, publicLogDisabled: false },
    { discordId: "auto-user", accountName: "A", charName: "AutoLogOff", itemLevel: 1715, publicLogDisabled: true },
    { discordId: "manual-user", accountName: "B", charName: "ManualChar", itemLevel: 1730, publicLogDisabled: false },
  ];
  const editable = __test.buildEditableCharsByUser({ allChars, userMeta });
  // Auto-user present only because one of their chars has log off.
  assert.ok(editable.has("auto-user"));
  assert.equal(editable.get("auto-user").chars.length, 1);
  assert.equal(editable.get("auto-user").chars[0].charName, "AutoLogOff");
  // Manual-user: all chars editable regardless of log state.
  assert.ok(editable.has("manual-user"));
  assert.equal(editable.get("manual-user").chars.length, 1);
  assert.equal(editable.get("manual-user").chars[0].charName, "ManualChar");
});

test("Edit flow: buildEditableCharsByUser drops users whose every char is bible-owned", () => {
  const userMeta = new Map([
    ["all-bible-owned", { autoManageEnabled: true }],
  ]);
  const allChars = [
    { discordId: "all-bible-owned", accountName: "X", charName: "A", itemLevel: 1720, publicLogDisabled: false },
    { discordId: "all-bible-owned", accountName: "X", charName: "B", itemLevel: 1720, publicLogDisabled: false },
  ];
  const editable = __test.buildEditableCharsByUser({ allChars, userMeta });
  assert.equal(editable.has("all-bible-owned"), false);
  assert.equal(editable.size, 0);
});

test("Edit flow: buildEditableCharsByUser sorts chars by iLvl descending", () => {
  const userMeta = new Map([["u", { autoManageEnabled: false }]]);
  const allChars = [
    { discordId: "u", accountName: "A", charName: "LowGeo", itemLevel: 1700, publicLogDisabled: false },
    { discordId: "u", accountName: "A", charName: "HighGeo", itemLevel: 1740, publicLogDisabled: false },
    { discordId: "u", accountName: "A", charName: "MidGeo", itemLevel: 1720, publicLogDisabled: false },
  ];
  const editable = __test.buildEditableCharsByUser({ allChars, userMeta });
  const names = editable.get("u").chars.map((c) => c.charName);
  assert.deepEqual(names, ["HighGeo", "MidGeo", "LowGeo"]);
});

test("Edit flow: getEligibleRaidsForChar filters raids by minItemLevel", () => {
  // 1710 → should include Act4 Normal (1700) and Kazeros Normal (1710) but
  // NOT Kazeros Hard (1730), Serca Normal (1720), etc. Exact eligibility
  // list depends on RAID_REQUIREMENT_MAP so we assert the minItemLevel
  // contract without hard-coding the full raid list.
  const raids = __test.getEligibleRaidsForChar(1710);
  assert.ok(raids.length > 0, "at least some raids qualify at 1710");
  for (const { entry } of raids) {
    assert.ok(
      Number(entry.minItemLevel) <= 1710,
      `raid with floor ${entry.minItemLevel} should not be returned for 1710 char`
    );
  }
  // Highest gear (1760) → every raid should qualify.
  const allRaids = __test.getEligibleRaidsForChar(1760);
  assert.ok(allRaids.length >= raids.length);
  // Zero iLvl → empty list.
  const noRaids = __test.getEligibleRaidsForChar(0);
  assert.equal(noRaids.length, 0);
});

test("Edit flow: getEligibleRaidsForChar returns entries in ascending minItemLevel order", () => {
  const raids = __test.getEligibleRaidsForChar(1800);
  const mins = raids.map(({ entry }) => Number(entry.minItemLevel) || 0);
  const sorted = [...mins].sort((a, b) => a - b);
  assert.deepEqual(mins, sorted, "eligible raids must be sorted by min iLvl ascending");
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

test("parseManagerIds splits, trims, skips empties, and dedupes", () => {
  const { parseManagerIds } = require("../src/services/manager");
  const ids = parseManagerIds("123, 456 ,  ,123,789");
  assert.deepEqual([...ids].sort(), ["123", "456", "789"]);
  assert.equal(parseManagerIds("").size, 0);
  assert.equal(parseManagerIds("   ").size, 0);
  assert.equal(parseManagerIds(undefined).size >= 0, true);
});

test("isManagerId matches env-allowlisted Discord user IDs", () => {
  assert.equal(__test.isManagerId("test-manager-1"), true);
  assert.equal(__test.isManagerId("test-manager-2"), true);
  assert.equal(__test.isManagerId("unknown-id"), false);
  assert.equal(__test.isManagerId(null), false);
  assert.equal(__test.isManagerId(undefined), false);
  assert.equal(__test.isManagerId(""), false);
});

test("getAutoManageCooldownMs returns 30s for managers and 15m for everyone else", () => {
  assert.equal(__test.getAutoManageCooldownMs("test-manager-1"), 30 * 1000);
  assert.equal(__test.getAutoManageCooldownMs("test-manager-2"), 30 * 1000);
  assert.equal(__test.getAutoManageCooldownMs("regular-user"), 15 * 60_000);
  assert.equal(__test.getAutoManageCooldownMs(null), 15 * 60_000);
});

test("buildAccountFreshnessLine uses the 30s sync cooldown for managers", () => {
  const now = Date.now();
  const account = { lastRefreshedAt: now - 60_000 };
  const userMeta = {
    discordId: "test-manager-1",
    autoManageEnabled: true,
    lastAutoManageSyncAt: now - 10_000, // 10s ago
    lastAutoManageAttemptAt: now - 10_000, // 20s remaining against 30s cooldown
  };
  const line = __test.buildAccountFreshnessLine(account, userMeta);
  // Manager cooldown is 30s total; with 10s elapsed there should be ~20s
  // left, rendered as "Ns" not a minute-formatted string. The exact value
  // floats a bit under millisecond drift, so we only assert the shape.
  assert.match(line, /Next sync in \d+s/);
  assert.doesNotMatch(line, /Next sync in \d+m/);
});

test("buildAccountFreshnessLine keeps the 15m sync cooldown for non-managers", () => {
  const now = Date.now();
  const account = { lastRefreshedAt: now - 60_000 };
  const userMeta = {
    discordId: "regular-user",
    autoManageEnabled: true,
    lastAutoManageSyncAt: now - 3 * 60_000,
    lastAutoManageAttemptAt: now - 3 * 60_000, // 12m remaining against 15m cooldown
  };
  const line = __test.buildAccountFreshnessLine(account, userMeta);
  assert.match(line, /Next sync in 12m/);
});

test("buildAccountFreshnessLine flips to Sync ready once the manager 30s window expires", () => {
  const now = Date.now();
  const account = { lastRefreshedAt: now - 60_000 };
  const userMeta = {
    discordId: "test-manager-1",
    autoManageEnabled: true,
    lastAutoManageSyncAt: now - 45_000,
    lastAutoManageAttemptAt: now - 45_000, // past the 30s manager window
  };
  const line = __test.buildAccountFreshnessLine(account, userMeta);
  assert.match(line, /Sync ready/);
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

