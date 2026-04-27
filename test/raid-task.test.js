// Seed env BEFORE requiring raid-command so the module-level boot
// warning for missing RAID_MANAGER_ID doesn't fire during tests.
process.env.RAID_MANAGER_ID = "test-manager-1";

const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../src/raid-command");
const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  generateTaskId,
  findCharacterInUser,
  countByReset,
  ensureSideTasks,
} = require("../src/commands/raid-task");

// ---------------------------------------------------------------------------
// dailyResetStartMs - LA daily reset is 17:00 VN = 10:00 UTC
// ---------------------------------------------------------------------------

test("dailyResetStartMs at 09:59 UTC snaps to YESTERDAY 10:00 UTC", () => {
  // Apr 22 2026 09:59 UTC → boundary not yet crossed → previous day's 10:00 UTC.
  const now = new Date(Date.UTC(2026, 3, 22, 9, 59, 0, 0));
  const result = __test.dailyResetStartMs(now);
  assert.equal(result, Date.UTC(2026, 3, 21, 10, 0, 0, 0));
});

test("dailyResetStartMs at 10:00 UTC snaps to TODAY 10:00 UTC", () => {
  // Boundary moment itself is the start of the new cycle.
  const now = new Date(Date.UTC(2026, 3, 22, 10, 0, 0, 0));
  const result = __test.dailyResetStartMs(now);
  assert.equal(result, Date.UTC(2026, 3, 22, 10, 0, 0, 0));
});

test("dailyResetStartMs at 23:59 UTC snaps to TODAY 10:00 UTC", () => {
  const now = new Date(Date.UTC(2026, 3, 22, 23, 59, 0, 0));
  const result = __test.dailyResetStartMs(now);
  assert.equal(result, Date.UTC(2026, 3, 22, 10, 0, 0, 0));
});

test("dailyResetStartMs returns ms equal to 17:00 VN (UTC+7)", () => {
  // Tests confirm the 10:00 UTC boundary corresponds to 17:00 VN.
  const now = new Date(Date.UTC(2026, 3, 22, 12, 0, 0, 0));
  const result = __test.dailyResetStartMs(now);
  const vnHourAtBoundary = new Date(result).getUTCHours() + 7;
  assert.equal(vnHourAtBoundary % 24, 17);
});

// ---------------------------------------------------------------------------
// raid-task module-level helpers
// ---------------------------------------------------------------------------

test("TASK_CAP constants are 3 daily + 5 weekly", () => {
  assert.equal(TASK_CAP_DAILY, 3);
  assert.equal(TASK_CAP_WEEKLY, 5);
});

test("generateTaskId returns non-empty string < 20 chars", () => {
  const id = generateTaskId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0 && id.length < 20);
});

test("generateTaskId is unique across rapid calls", () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    ids.add(generateTaskId());
  }
  // Allow up to 2 collisions out of 200 to absorb deep timestamp collision
  // edges; in practice the random component dominates and we see 0/200.
  assert.ok(ids.size >= 198, `expected ~200 unique ids, got ${ids.size}`);
});

test("findCharacterInUser returns null on empty doc", () => {
  assert.equal(findCharacterInUser(null, "Bob"), null);
  assert.equal(findCharacterInUser({}, "Bob"), null);
  assert.equal(findCharacterInUser({ accounts: [] }, "Bob"), null);
});

test("findCharacterInUser case-insensitive name match", () => {
  const userDoc = {
    accounts: [
      {
        accountName: "main",
        characters: [
          { name: "Frostmourne", class: "Berserker", itemLevel: 1700 },
          { name: "BlazingSun", class: "Bard", itemLevel: 1690 },
        ],
      },
    ],
  };
  const lower = findCharacterInUser(userDoc, "frostmourne");
  assert.ok(lower);
  assert.equal(lower.character.name, "Frostmourne");
  const mixed = findCharacterInUser(userDoc, "BLAZINGsun");
  assert.ok(mixed);
  assert.equal(mixed.character.name, "BlazingSun");
});

test("findCharacterInUser returns first match across multiple accounts", () => {
  const userDoc = {
    accounts: [
      { accountName: "alt", characters: [{ name: "Echo", class: "Bard", itemLevel: 1600 }] },
      { accountName: "main", characters: [{ name: "Echo", class: "Sorc", itemLevel: 1700 }] },
    ],
  };
  const found = findCharacterInUser(userDoc, "Echo");
  assert.ok(found);
  // First-by-iteration: alt account wins since it's account[0].
  assert.equal(found.account.accountName, "alt");
});

test("countByReset filters by daily/weekly correctly", () => {
  const sideTasks = [
    { reset: "daily", name: "Una1", completed: false },
    { reset: "weekly", name: "Guardian", completed: true },
    { reset: "daily", name: "Una2", completed: true },
    { reset: "weekly", name: "Chaos", completed: false },
    { reset: "weekly", name: "GvG", completed: false },
  ];
  assert.equal(countByReset(sideTasks, "daily"), 2);
  assert.equal(countByReset(sideTasks, "weekly"), 3);
  assert.equal(countByReset(sideTasks, "monthly"), 0);
});

test("ensureSideTasks initializes missing array", () => {
  const character = {};
  const result = ensureSideTasks(character);
  assert.deepEqual(result, []);
  assert.deepEqual(character.sideTasks, []);
});

test("ensureSideTasks returns existing array unchanged", () => {
  const character = {
    sideTasks: [{ taskId: "abc", name: "Una", reset: "daily", completed: false }],
  };
  const result = ensureSideTasks(character);
  assert.equal(result.length, 1);
  assert.equal(result[0].taskId, "abc");
});

// ---------------------------------------------------------------------------
// Privacy regression: /raid-check all-mode .select projection
// ---------------------------------------------------------------------------

test("PRIVACY: raid-check all-mode select() does NOT include sideTasks", () => {
  // The all-mode .select() string is expected to enumerate explicit account
  // subfields rather than the entire `accounts` blob. If a future refactor
  // shortens it back to "accounts", side tasks would leak into the manager
  // view - this regression test pins the explicit list.
  const fs = require("fs");
  const path = require("path");
  const allModeSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "commands", "raid-check", "all-mode.js"),
    "utf8"
  );
  // Find the User.find select call.
  const match = allModeSrc.match(
    /User\.find\([^)]*\)\s*\.select\(\s*\[([\s\S]*?)\]\.join/
  );
  assert.ok(match, "expected explicit array-style select() in all-mode.js");
  const fieldList = match[1];
  assert.ok(
    !fieldList.includes("sideTasks"),
    "sideTasks must NOT appear in all-mode select projection"
  );
  // Also assert the bare `"accounts"` (whole-array) is NOT present - that
  // would silently re-include sideTasks via Mongo's parent-path semantics.
  assert.ok(
    !/"accounts"\s*,/.test(fieldList),
    "select must not project the entire accounts array"
  );
});

test("PRIVACY: RAID_CHECK_USER_QUERY_FIELDS allowlist excludes sideTasks", () => {
  const {
    RAID_CHECK_USER_QUERY_FIELDS,
  } = require("../src/raid/raid-check-query");
  assert.ok(typeof RAID_CHECK_USER_QUERY_FIELDS === "string");
  assert.ok(
    !RAID_CHECK_USER_QUERY_FIELDS.includes("sideTasks"),
    "sideTasks must not be in /raid-check select projection"
  );
});

// ---------------------------------------------------------------------------
// resetExpiredSideTasks - bulk update behavior
// ---------------------------------------------------------------------------

test("resetExpiredSideTasks issues 2 updateMany calls (daily + weekly) with the right filter shape", async () => {
  // Inject a tiny User stub that records the args of each updateMany call.
  // We need to drive the side-task scheduler factory ourselves to plug in
  // the stub; the public createRaidSchedulerService is an OK seam since
  // dailyResetStartMs/resetExpiredSideTasks live there.
  const calls = [];
  const userStub = {
    updateMany: async (filter, update, options) => {
      calls.push({ filter, update, options });
      return { modifiedCount: 0 };
    },
  };

  const {
    createRaidSchedulerService,
  } = require("../src/services/raid-schedulers");
  const service = createRaidSchedulerService({
    GuildConfig: {},
    User: userStub,
    saveWithRetry: async (fn) => fn(),
    ensureFreshWeek: () => {},
    getAnnouncementsConfig: () => ({}),
    cleanupRaidChannelMessages: async () => {},
    weekResetStartMs: () => Date.UTC(2026, 3, 22, 10, 0, 0, 0),
    acquireAutoManageSyncSlot: async () => ({ acquired: false }),
    releaseAutoManageSyncSlot: () => {},
    gatherAutoManageLogsForUserDoc: async () => ({}),
    applyAutoManageCollected: () => ({ perChar: [] }),
    isPublicLogDisabledError: () => false,
    stampAutoManageAttempt: async () => {},
  });

  // Anchor 'now' at Apr 22 2026 12:00 UTC so dailyResetStartMs lands on
  // 2026-04-22T10:00:00Z and weekly stays at the same instant (Wed).
  const now = new Date(Date.UTC(2026, 3, 22, 12, 0, 0, 0));
  const report = await service.resetExpiredSideTasks(now);

  assert.equal(calls.length, 2, "expected 2 updateMany calls (daily + weekly)");
  assert.equal(report.dailyModified, 0);
  assert.equal(report.weeklyModified, 0);
  assert.equal(report.dailyStart, Date.UTC(2026, 3, 22, 10, 0, 0, 0));

  const [dailyCall, weeklyCall] = calls;

  // Daily call: filters tasks with reset=daily AND lastResetAt < dailyStart.
  assert.equal(dailyCall.options.arrayFilters[0]["task.reset"], "daily");
  assert.equal(
    dailyCall.options.arrayFilters[0]["task.lastResetAt"]["$lt"],
    Date.UTC(2026, 3, 22, 10, 0, 0, 0)
  );
  // The $set targets nested arrays via $[].
  assert.ok(
    "accounts.$[].characters.$[].sideTasks.$[task].completed" in dailyCall.update.$set
  );
  assert.equal(
    dailyCall.update.$set["accounts.$[].characters.$[].sideTasks.$[task].completed"],
    false
  );

  // Weekly call: filter targets reset=weekly + lastResetAt < weeklyStart.
  assert.equal(weeklyCall.options.arrayFilters[0]["task.reset"], "weekly");
  assert.equal(
    weeklyCall.options.arrayFilters[0]["task.lastResetAt"]["$lt"],
    Date.UTC(2026, 3, 22, 10, 0, 0, 0)
  );
});

test("resetExpiredSideTasks reports modifiedCount accurately when Mongo touches docs", async () => {
  const userStub = {
    updateMany: async (filter, update, options) => {
      // Pretend daily flushed 4 task entries, weekly flushed 2.
      const isDaily = options.arrayFilters[0]["task.reset"] === "daily";
      return { modifiedCount: isDaily ? 4 : 2 };
    },
  };
  const {
    createRaidSchedulerService,
  } = require("../src/services/raid-schedulers");
  const service = createRaidSchedulerService({
    GuildConfig: {},
    User: userStub,
    saveWithRetry: async (fn) => fn(),
    ensureFreshWeek: () => {},
    getAnnouncementsConfig: () => ({}),
    cleanupRaidChannelMessages: async () => {},
    weekResetStartMs: () => 0,
    acquireAutoManageSyncSlot: async () => ({ acquired: false }),
    releaseAutoManageSyncSlot: () => {},
    gatherAutoManageLogsForUserDoc: async () => ({}),
    applyAutoManageCollected: () => ({ perChar: [] }),
    isPublicLogDisabledError: () => false,
    stampAutoManageAttempt: async () => {},
  });
  const report = await service.resetExpiredSideTasks(
    new Date(Date.UTC(2026, 3, 22, 12, 0, 0, 0))
  );
  assert.equal(report.dailyModified, 4);
  assert.equal(report.weeklyModified, 2);
});
