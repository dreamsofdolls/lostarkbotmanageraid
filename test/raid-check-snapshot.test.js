// Seed RAID_MANAGER_ID before requiring bot/commands so manager.js captures
// a deterministic allowlist at module load. Tests below rely on these IDs
// to verify manager-specific cooldown branching.
process.env.RAID_MANAGER_ID = "test-manager-1,test-manager-2";

const test = require("node:test");
const assert = require("node:assert/strict");

const { __test, parseRaidMessage } = require("../bot/commands");
const { ensureFreshWeek, getTargetResetKey } = require("../bot/services/raid/schedulers/weekly-reset");
const { lookupArray } = require("../bot/utils/raid/schedule/locale-arrays");

test("raid-status pagination stays open longer than raid-check", () => {
  assert.equal(__test.STATUS_PAGINATION_SESSION_MS, 10 * 60 * 1000);
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
  // Fifty draws should cover all three variants (probability of
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

test("Artist cleanup count bucket boundaries are shared by hourly and wake-up notices", () => {
  assert.equal(__test.cleanupCountBucket(-1), "empty");
  assert.equal(__test.cleanupCountBucket(0), "empty");
  assert.equal(__test.cleanupCountBucket(1), "trivial");
  assert.equal(__test.cleanupCountBucket(5), "trivial");
  assert.equal(__test.cleanupCountBucket(6), "normal");
  assert.equal(__test.cleanupCountBucket(20), "normal");
  assert.equal(__test.cleanupCountBucket(21), "heavy");
});

test("Artist quiet hours: wake-up pool is disjoint from the hourly-cleanup pool", () => {
  // Regression guard: a future refactor might merge the two pools by accident.
  // The wake-up moment is ceremonial (morning) and the hourly one is not, so
  // their variant sets must stay separate.
  const wakeupSamples = lookupArray("vi", "announcements.artist-wakeup.normal");
  const hourlySamples = new Set(
    lookupArray("vi", "announcements.cleanup-volume.normal"),
  );
  // Any wake-up line mentioning "morning" or "dậy" should never appear in the
  // regular hourly pool (verified by checking a few hourly outputs).
  const morningMarkers = wakeupSamples.filter((s) => /dậy|Morning|sáng/i.test(s));
  assert.ok(morningMarkers.length > 0, "wake-up pool must contain morning-tone lines");
  assert.deepEqual(
    wakeupSamples.filter((sample) => hourlySamples.has(sample)),
    [],
    "wake-up and hourly-cleanup pools must remain disjoint",
  );
});

test("nextAnnouncementEligibleBoundaryMs: artist-bedtime lands on next 20:00 UTC (= 03:00 VN)", () => {
  // Thu Apr 23 2026 19:00 UTC (02:00 VN Apr 24) → next bedtime = 20:00 UTC same day.
  const before = new Date(Date.UTC(2026, 3, 23, 19, 0, 0, 0));
  const fire = __test.nextAnnouncementEligibleBoundaryMs("artist-bedtime", before);
  assert.equal(fire, Date.UTC(2026, 3, 23, 20, 0, 0, 0));

  // Exactly at 20:00 UTC advances to the next day because the boundary is inclusive.
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
  // Exactly zero at the boundary returns null and suppresses "0s".
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
    lastAutoManageAttemptAt: now - 3 * 60_000, // cooldown still active (10m default)
  };
  const line = __test.buildAccountFreshnessLine(account, userMeta);
  // Discord native timestamps render `<t:UNIX:R>` client-side; tests just
  // assert the shape is present + UNIX value is in the right ballpark.
  // Wording uses "Refresh sẵn sàng" / "Sync sẵn sàng" + timestamp so both future
  // ("in 14s") and past ("16s ago") tenses read cleanly without the
  // "Next sync ... ago" awkwardness.
  assert.match(line, /Cập nhật <t:\d+:R>/);
  assert.match(line, /Refresh sẵn sàng <t:\d+:R>/);
  assert.match(line, /Sync gần nhất <t:\d+:R>/);
  assert.match(line, /Sync sẵn sàng <t:\d+:R>/);
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
  assert.match(line, /Refresh sẵn sàng/);
  assert.match(line, /Sync sẵn sàng/);
});

test("buildAccountFreshnessLine honors short refresh failure cooldown", () => {
  const now = Date.now();
  const account = {
    lastRefreshedAt: now - 3 * 60 * 60_000, // success cooldown expired
    lastRefreshAttemptAt: now - 2 * 60_000, // but a failed attempt is still cooling down
  };
  const line = __test.buildAccountFreshnessLine(account, { autoManageEnabled: false });
  assert.match(line, /Cập nhật <t:\d+:R>/);
  assert.match(line, /⏳ Refresh sẵn sàng <t:\d+:R>/);
  assert.doesNotMatch(line, /✅ Refresh sẵn sàng/);
});

test("buildAccountFreshnessLine omits sync badge when auto-manage is off", () => {
  const account = { lastRefreshedAt: Date.now() - 60_000 };
  const line = __test.buildAccountFreshnessLine(account, { autoManageEnabled: false });
  assert.match(line, /Cập nhật/);
  assert.doesNotMatch(line, /synced/);
  assert.doesNotMatch(line, /Sync/);
});

test("parseManagerIds splits, trims, skips empties, and dedupes", () => {
  const { parseManagerIds } = require("../bot/services/access/manager");
  const ids = parseManagerIds("123, 456 ,  ,123,789");
  assert.deepEqual([...ids].sort(), ["123", "456", "789"]);
  assert.equal(parseManagerIds("").size, 0);
  assert.equal(parseManagerIds("   ").size, 0);
  assert.deepEqual(
    [...parseManagerIds(undefined)].sort(),
    ["test-manager-1", "test-manager-2"],
  );
});

test("isManagerId matches env-allowlisted Discord user IDs", () => {
  assert.equal(__test.isManagerId("test-manager-1"), true);
  assert.equal(__test.isManagerId("test-manager-2"), true);
  assert.equal(__test.isManagerId("unknown-id"), false);
  assert.equal(__test.isManagerId(null), false);
  assert.equal(__test.isManagerId(undefined), false);
  assert.equal(__test.isManagerId(""), false);
});

test("getAutoManageCooldownMs returns 15s for managers and 10m for everyone else", () => {
  // Cooldowns tightened on 2026-04-26: Manager 30s -> 15s, regular 15m -> 10m.
  assert.equal(__test.getAutoManageCooldownMs("test-manager-1"), 15 * 1000);
  assert.equal(__test.getAutoManageCooldownMs("test-manager-2"), 15 * 1000);
  assert.equal(__test.getAutoManageCooldownMs("regular-user"), 10 * 60_000);
  assert.equal(__test.getAutoManageCooldownMs(null), 10 * 60_000);
});

test("buildAccountFreshnessLine uses the 15s sync cooldown for managers", () => {
  const now = Date.now();
  const account = { lastRefreshedAt: now - 60_000 };
  const userMeta = {
    discordId: "test-manager-1",
    autoManageEnabled: true,
    lastAutoManageSyncAt: now - 5_000, // 5s ago
    lastAutoManageAttemptAt: now - 5_000, // 10s remaining against 15s cooldown
  };
  const line = __test.buildAccountFreshnessLine(account, userMeta);
  // Manager cooldown 15s; with the move to Discord native timestamps the
  // string is `<t:UNIX:R>` and Discord renders the relative text. Verify
  // the next-sync UNIX is within ~15s of now (manager cooldown window).
  const nextMatch = line.match(/⏳ Sync sẵn sàng <t:(\d+):R>/);
  assert.ok(nextMatch, `expected Next sync timestamp; got: ${line}`);
  const nextEligibleMs = Number(nextMatch[1]) * 1000;
  const remainingMs = nextEligibleMs - now;
  assert.ok(remainingMs > 0 && remainingMs <= 15_000, `expected <=15s manager cooldown remaining, got ${remainingMs}ms`);
});

test("buildAccountFreshnessLine keeps the 10m sync cooldown for non-managers", () => {
  const now = Date.now();
  const account = { lastRefreshedAt: now - 60_000 };
  const userMeta = {
    discordId: "regular-user",
    autoManageEnabled: true,
    lastAutoManageSyncAt: now - 3 * 60_000,
    lastAutoManageAttemptAt: now - 3 * 60_000, // 7m remaining against 10m cooldown
  };
  const line = __test.buildAccountFreshnessLine(account, userMeta);
  // 7m remaining, encoded as Unix seconds. ~5-9 minute window allows
  // millisecond drift between line render + assertion.
  const nextMatch = line.match(/⏳ Sync sẵn sàng <t:(\d+):R>/);
  assert.ok(nextMatch);
  const remainingMs = Number(nextMatch[1]) * 1000 - now;
  assert.ok(remainingMs > 5 * 60_000 && remainingMs < 9 * 60_000);
});

test("buildAccountFreshnessLine flips to Sync sẵn sàng once the manager 15s window expires", () => {
  const now = Date.now();
  const account = { lastRefreshedAt: now - 60_000 };
  const userMeta = {
    discordId: "test-manager-1",
    autoManageEnabled: true,
    lastAutoManageSyncAt: now - 30_000,
    lastAutoManageAttemptAt: now - 30_000, // past the 15s manager window
  };
  const line = __test.buildAccountFreshnessLine(account, userMeta);
  assert.match(line, /Sync sẵn sàng/);
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
