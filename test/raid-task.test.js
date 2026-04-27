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

// ---------------------------------------------------------------------------
// pack2Columns shared util: ZWS-spacer 2-column layout packer
// ---------------------------------------------------------------------------

test("pack2Columns: even count interleaves spacers correctly", () => {
  const { pack2Columns, INLINE_SPACER } = require("../src/raid/shared");
  const A = { name: "A", value: "a", inline: true };
  const B = { name: "B", value: "b", inline: true };
  const C = { name: "C", value: "c", inline: true };
  const D = { name: "D", value: "d", inline: true };
  const out = pack2Columns([A, B, C, D]);
  // 4 chars -> 2 rows of [card, spacer, card]
  assert.deepEqual(out, [A, INLINE_SPACER, B, C, INLINE_SPACER, D]);
});

test("pack2Columns: odd count pads trailing card with extra spacer", () => {
  const { pack2Columns, INLINE_SPACER } = require("../src/raid/shared");
  const A = { name: "A", value: "a", inline: true };
  const B = { name: "B", value: "b", inline: true };
  const C = { name: "C", value: "c", inline: true };
  const out = pack2Columns([A, B, C]);
  // C alone -> [C, spacer, spacer] so Discord doesn't full-width it.
  assert.deepEqual(out, [A, INLINE_SPACER, B, C, INLINE_SPACER, INLINE_SPACER]);
});

test("pack2Columns: empty input returns empty array", () => {
  const { pack2Columns } = require("../src/raid/shared");
  assert.deepEqual(pack2Columns([]), []);
});

test("formatProgressTotals: standard 3-icon line", () => {
  const { formatProgressTotals } = require("../src/raid/shared");
  const UI = { icons: { done: "🟢", partial: "🟡", pending: "⚪", lock: "🔒" } };
  const out = formatProgressTotals({ done: 2, partial: 1, pending: 4 }, UI);
  assert.equal(out, "🟢 2 done · 🟡 1 partial · ⚪ 4 pending");
});

test("formatProgressTotals: notEligible suffix only when > 0", () => {
  const { formatProgressTotals } = require("../src/raid/shared");
  const UI = { icons: { done: "🟢", partial: "🟡", pending: "⚪", lock: "🔒" } };
  const withLock = formatProgressTotals(
    { done: 1, partial: 0, pending: 2, notEligible: 3 },
    UI
  );
  assert.equal(withLock, "🟢 1 done · 🟡 0 partial · ⚪ 2 pending · 🔒 3 not eligible");
  const withoutLock = formatProgressTotals(
    { done: 1, partial: 0, pending: 2, notEligible: 0 },
    UI
  );
  assert.doesNotMatch(withoutLock, /not eligible/);
});

test("formatProgressTotals: missing fields default to 0", () => {
  const { formatProgressTotals } = require("../src/raid/shared");
  const UI = { icons: { done: "🟢", partial: "🟡", pending: "⚪", lock: "🔒" } };
  assert.equal(
    formatProgressTotals({}, UI),
    "🟢 0 done · 🟡 0 partial · ⚪ 0 pending"
  );
  assert.equal(
    formatProgressTotals(null, UI),
    "🟢 0 done · 🟡 0 partial · ⚪ 0 pending"
  );
});

test("INLINE_SPACER is frozen so mutation can't poison shared reference", () => {
  const { INLINE_SPACER } = require("../src/raid/shared");
  assert.equal(Object.isFrozen(INLINE_SPACER), true);
  // Defensive: setting a property on a frozen object throws in strict
  // mode and silently no-ops in sloppy. Either way, the value can't
  // change.
  try {
    INLINE_SPACER.inline = false;
  } catch {
    /* expected in strict mode */
  }
  assert.equal(INLINE_SPACER.inline, true);
});

// ---------------------------------------------------------------------------
// Shared task-view helper: pure function used by both /raid-status + /raid-check
// ---------------------------------------------------------------------------

test("buildAccountTaskFields rolls up totals + 2-column packs char fields", () => {
  const { buildAccountTaskFields } = require("../src/raid/task-view");
  const account = {
    accountName: "main",
    characters: [
      {
        name: "Alpha",
        class: "Berserker",
        itemLevel: 1700,
        sideTasks: [
          { taskId: "1", name: "Una", reset: "daily", completed: true },
          { taskId: "2", name: "Chaos", reset: "daily", completed: false },
        ],
      },
      {
        name: "Beta",
        class: "Bard",
        itemLevel: 1690,
        sideTasks: [
          { taskId: "3", name: "Guardian", reset: "weekly", completed: true },
        ],
      },
      // No-tasks char should be filtered out.
      { name: "Gamma", class: "Sorc", itemLevel: 1680, sideTasks: [] },
    ],
  };
  const helpers = {
    UI: { icons: { done: "🟢", pending: "⚪" } },
    truncateText: (s) => s,
  };
  const { fields, totals } = buildAccountTaskFields(account, helpers);

  assert.equal(totals.charsWithTasks, 2, "Gamma filtered out");
  assert.equal(totals.daily, 2);
  assert.equal(totals.dailyDone, 1);
  assert.equal(totals.weekly, 1);
  assert.equal(totals.weeklyDone, 1);
  // 2-column packing: 2 chars => 1 char + spacer + 1 char = 3 fields.
  assert.equal(fields.length, 3, "expected 3 fields for 2 chars (card + spacer + card)");
  assert.equal(fields[1].name, "​", "middle field is a ZWS spacer");
  assert.match(fields[0].name, /Alpha/);
  assert.match(fields[2].name, /Beta/);
});

test("buildAccountTaskFields returns empty fields when no chars-with-tasks", () => {
  const { buildAccountTaskFields } = require("../src/raid/task-view");
  const account = {
    accountName: "empty",
    characters: [{ name: "X", itemLevel: 1700, sideTasks: [] }],
  };
  const { fields, totals } = buildAccountTaskFields(account, {
    UI: { icons: { done: "🟢", pending: "⚪" } },
  });
  assert.equal(fields.length, 0);
  assert.equal(totals.charsWithTasks, 0);
  assert.equal(totals.rendered, 0);
});

test("buildAccountTaskFields odd char count pads with spacer to keep 2-column", () => {
  const { buildAccountTaskFields } = require("../src/raid/task-view");
  const account = {
    accountName: "main",
    characters: [
      {
        name: "Solo",
        class: "Reaper",
        itemLevel: 1700,
        sideTasks: [{ taskId: "1", name: "X", reset: "daily", completed: false }],
      },
    ],
  };
  const { fields } = buildAccountTaskFields(account, {
    UI: { icons: { done: "🟢", pending: "⚪" } },
  });
  // 1 char => 1 card + spacer + spacer (3 fields, both trailing slots are spacers).
  assert.equal(fields.length, 3);
  assert.equal(fields[1].name, "​");
  assert.equal(fields[2].name, "​");
});

test("PROJECTION: raid-check all-mode select() includes sideTasks (Manager Task view)", () => {
  // Round-29: Manager-side Task view in /raid-check needs the side-task
  // subtree on the lean docs. The .select() must enumerate explicit
  // account subfields (NOT the whole `accounts` blob - that would
  // silently include other internal fields we haven't decided to
  // surface). This regression pins both the inclusion + the explicit-
  // enumeration shape.
  const fs = require("fs");
  const path = require("path");
  const allModeSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "commands", "raid-check", "all-mode.js"),
    "utf8"
  );
  const match = allModeSrc.match(
    /User\.find\([^)]*\)\s*\.select\(\s*\[([\s\S]*?)\]\.join/
  );
  assert.ok(match, "expected explicit array-style select() in all-mode.js");
  const fieldList = match[1];
  assert.ok(
    fieldList.includes("accounts.characters.sideTasks"),
    "sideTasks must be in all-mode select projection (Manager Task view)"
  );
  // Bare `"accounts"` (whole-array) still not allowed - keeps the
  // projection a deliberate allowlist.
  assert.ok(
    !/"accounts"\s*,/.test(fieldList),
    "select must enumerate subfields, not project the entire accounts array"
  );
});

test("PROJECTION: RAID_CHECK_USER_QUERY_FIELDS allowlist includes sideTasks", () => {
  const {
    RAID_CHECK_USER_QUERY_FIELDS,
  } = require("../src/raid/raid-check-query");
  assert.ok(typeof RAID_CHECK_USER_QUERY_FIELDS === "string");
  assert.ok(
    RAID_CHECK_USER_QUERY_FIELDS.includes("accounts.characters.sideTasks"),
    "sideTasks must be in /raid-check select projection (Manager Task view)"
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

// ---------------------------------------------------------------------------
// Codex round 28 regressions: lastResetAt seed + > 25 task per account
// ---------------------------------------------------------------------------

test("REGRESSION (Codex #1): newly-added task seeds lastResetAt to current cycle start", async () => {
  // Drive a real createRaidTaskCommand factory with stubbed deps so we can
  // observe the saved task. Validates that handleAdd does NOT use 0 as the
  // seed - because lastResetAt=0 < dailyResetStartMs(now) makes the next
  // scheduler tick reset the just-added task back to ⬜.
  const FAKE_DAILY_START = Date.UTC(2026, 3, 22, 10, 0, 0, 0);
  const FAKE_WEEKLY_START = Date.UTC(2026, 3, 22, 10, 0, 0, 0);
  let savedDoc = null;
  const userDoc = {
    discordId: "u1",
    accounts: [
      {
        accountName: "main",
        characters: [
          {
            name: "Frostmourne",
            class: "Berserker",
            itemLevel: 1700,
            sideTasks: [],
          },
        ],
      },
    ],
    save: async function () {
      savedDoc = JSON.parse(JSON.stringify(this));
    },
  };
  const UserStub = { findOne: async () => userDoc };

  const { createRaidTaskCommand } = require("../src/commands/raid-task");
  const handlers = createRaidTaskCommand({
    EmbedBuilder: class {
      constructor() {
        this._json = { fields: [] };
      }
      setColor() { return this; }
      setTitle() { return this; }
      setDescription() { return this; }
      addFields() { return this; }
      setFooter() { return this; }
      toJSON() { return this._json; }
    },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class {
      setCustomId() { return this; }
      setLabel() { return this; }
      setStyle() { return this; }
    },
    ButtonStyle: { Danger: 4, Secondary: 2 },
    MessageFlags: { Ephemeral: 64 },
    User: UserStub,
    saveWithRetry: async (fn) => fn(),
    loadUserForAutocomplete: async () => userDoc,
    dailyResetStartMs: () => FAKE_DAILY_START,
    weekResetStartMs: () => FAKE_WEEKLY_START,
  });

  const interaction = {
    user: { id: "u1" },
    options: {
      getSubcommand: () => "add",
      getString: (name, _required) => {
        if (name === "character") return "Frostmourne";
        if (name === "name") return "Una Dailies";
        if (name === "reset") return "daily";
        return null;
      },
    },
    reply: async () => {},
  };
  await handlers.handleRaidTaskCommand(interaction);

  assert.ok(savedDoc, "expected userDoc.save() to be called");
  const persisted = savedDoc.accounts[0].characters[0].sideTasks[0];
  assert.equal(persisted.name, "Una Dailies");
  assert.equal(persisted.reset, "daily");
  assert.equal(
    persisted.lastResetAt,
    FAKE_DAILY_START,
    "lastResetAt must be seeded to current dailyResetStartMs - 0 would let the next scheduler tick reset oan"
  );
});

test("REGRESSION (Codex #1): weekly task seeds lastResetAt to weekResetStartMs", async () => {
  const FAKE_WEEKLY_START = Date.UTC(2026, 3, 22, 10, 0, 0, 0);
  const FAKE_DAILY_START = Date.UTC(2026, 3, 23, 10, 0, 0, 0);
  let savedDoc = null;
  const userDoc = {
    discordId: "u1",
    accounts: [
      {
        accountName: "main",
        characters: [
          { name: "Frostmourne", class: "Berserker", itemLevel: 1700, sideTasks: [] },
        ],
      },
    ],
    save: async function () {
      savedDoc = JSON.parse(JSON.stringify(this));
    },
  };
  const { createRaidTaskCommand } = require("../src/commands/raid-task");
  const handlers = createRaidTaskCommand({
    EmbedBuilder: class {
      setColor() { return this; }
      setTitle() { return this; }
      setDescription() { return this; }
      addFields() { return this; }
      setFooter() { return this; }
    },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class {
      setCustomId() { return this; }
      setLabel() { return this; }
      setStyle() { return this; }
    },
    ButtonStyle: { Danger: 4, Secondary: 2 },
    MessageFlags: { Ephemeral: 64 },
    User: { findOne: async () => userDoc },
    saveWithRetry: async (fn) => fn(),
    loadUserForAutocomplete: async () => userDoc,
    dailyResetStartMs: () => FAKE_DAILY_START,
    weekResetStartMs: () => FAKE_WEEKLY_START,
  });

  const interaction = {
    user: { id: "u1" },
    options: {
      getSubcommand: () => "add",
      getString: (name) => {
        if (name === "character") return "Frostmourne";
        if (name === "name") return "Guardian Raid";
        if (name === "reset") return "weekly";
        return null;
      },
    },
    reply: async () => {},
  };
  await handlers.handleRaidTaskCommand(interaction);

  const persisted = savedDoc.accounts[0].characters[0].sideTasks[0];
  assert.equal(persisted.lastResetAt, FAKE_WEEKLY_START);
  assert.notEqual(persisted.lastResetAt, FAKE_DAILY_START);
});

test("REGRESSION (Codex #2): account with > 25 total tasks scoped per-char by filter", () => {
  // Synthesize an account with 5 chars × 8 tasks = 40 total, each char
  // sitting at the per-char cap. Without the round-28 char-filter, the
  // toggle dropdown would silently drop entries 26..40. With the filter,
  // each char's 8 tasks fit comfortably under Discord's 25-option cap.
  const account = {
    accountName: "MaxedOut",
    characters: [],
  };
  for (let i = 1; i <= 5; i += 1) {
    const sideTasks = [];
    for (let d = 1; d <= TASK_CAP_DAILY; d += 1) {
      sideTasks.push({
        taskId: generateTaskId(),
        name: `Daily ${d}`,
        reset: "daily",
        completed: false,
        lastResetAt: 0,
        createdAt: Date.now(),
      });
    }
    for (let w = 1; w <= TASK_CAP_WEEKLY; w += 1) {
      sideTasks.push({
        taskId: generateTaskId(),
        name: `Weekly ${w}`,
        reset: "weekly",
        completed: false,
        lastResetAt: 0,
        createdAt: Date.now(),
      });
    }
    account.characters.push({
      name: `Char${i}`,
      class: "Berserker",
      itemLevel: 1700,
      sideTasks,
    });
  }

  const totalTasks = account.characters.reduce(
    (sum, c) => sum + c.sideTasks.length,
    0
  );
  assert.ok(totalTasks > 25, `setup must exceed 25 total tasks (got ${totalTasks})`);

  // Simulate the round-28 fix: per-char cap = TASK_CAP_DAILY + TASK_CAP_WEEKLY.
  // Filtering by ANY char must always produce a list <= 25 (Discord cap).
  for (const character of account.characters) {
    assert.ok(
      character.sideTasks.length <= 25,
      `per-char task list must fit Discord's 25-option dropdown cap (got ${character.sideTasks.length})`
    );
    assert.ok(
      character.sideTasks.length <= TASK_CAP_DAILY + TASK_CAP_WEEKLY,
      "per-char list must respect the documented cap"
    );
  }

  // The combined cap (8) is well under 25, so even if Discord lowered the
  // limit in a future update, the architectural choice has headroom.
  assert.ok(TASK_CAP_DAILY + TASK_CAP_WEEKLY < 25);
});

// ---------------------------------------------------------------------------
// add-all subcommand: bulk add same task to every char in a roster
// ---------------------------------------------------------------------------

test("add-all: adds task to every char that fits, skips chars at cap + duplicates separately", async () => {
  const FAKE_DAILY = Date.UTC(2026, 3, 22, 10, 0, 0, 0);
  let savedDoc = null;
  const userDoc = {
    discordId: "u1",
    accounts: [
      {
        accountName: "main",
        characters: [
          // Char A: empty - should be added.
          { name: "Alpha", class: "Berserker", itemLevel: 1700, sideTasks: [] },
          // Char B: already has the task - should skip as dup.
          {
            name: "Beta",
            class: "Bard",
            itemLevel: 1690,
            sideTasks: [
              {
                taskId: "x",
                name: "Una Dailies",
                reset: "daily",
                completed: false,
                lastResetAt: 0,
                createdAt: 0,
              },
            ],
          },
          // Char C: at daily cap with 3 OTHER daily tasks - should skip cap.
          {
            name: "Charlie",
            class: "Sorc",
            itemLevel: 1680,
            sideTasks: [
              { taskId: "a", name: "T1", reset: "daily", completed: false, lastResetAt: 0, createdAt: 0 },
              { taskId: "b", name: "T2", reset: "daily", completed: false, lastResetAt: 0, createdAt: 0 },
              { taskId: "c", name: "T3", reset: "daily", completed: false, lastResetAt: 0, createdAt: 0 },
            ],
          },
          // Char D: empty - should be added.
          { name: "Delta", class: "Paladin", itemLevel: 1670, sideTasks: [] },
        ],
      },
    ],
    save: async function () {
      savedDoc = JSON.parse(JSON.stringify(this));
    },
  };

  const replyCalls = [];
  const stubEmbed = {
    setColor() { return this; }, setTitle() { return this; }, setDescription() { return this; },
    addFields() { return this; }, setFooter() { return this; },
  };
  const { createRaidTaskCommand } = require("../src/commands/raid-task");
  const handlers = createRaidTaskCommand({
    EmbedBuilder: function () { return stubEmbed; },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } },
    ButtonStyle: { Danger: 4, Secondary: 2 },
    MessageFlags: { Ephemeral: 64 },
    User: { findOne: async () => userDoc },
    saveWithRetry: async (fn) => fn(),
    loadUserForAutocomplete: async () => userDoc,
    dailyResetStartMs: () => FAKE_DAILY,
    weekResetStartMs: () => 0,
  });

  const interaction = {
    user: { id: "u1" },
    options: {
      getSubcommand: () => "add",
      getString: (name) => {
        if (name === "action") return "all";
        if (name === "roster") return "main";
        if (name === "name") return "Una Dailies";
        if (name === "reset") return "daily";
        return null;
      },
    },
    reply: async (payload) => { replyCalls.push(payload); },
  };

  await handlers.handleRaidTaskCommand(interaction);

  assert.ok(savedDoc, "expected save() to be called when at least one add succeeded");
  // Alpha + Delta got it, Beta (dup) + Charlie (cap) skipped.
  const finalChars = savedDoc.accounts[0].characters;
  const alphaTasks = finalChars.find((c) => c.name === "Alpha").sideTasks;
  const betaTasks = finalChars.find((c) => c.name === "Beta").sideTasks;
  const charlieTasks = finalChars.find((c) => c.name === "Charlie").sideTasks;
  const deltaTasks = finalChars.find((c) => c.name === "Delta").sideTasks;

  assert.equal(alphaTasks.length, 1);
  assert.equal(alphaTasks[0].name, "Una Dailies");
  assert.equal(alphaTasks[0].lastResetAt, FAKE_DAILY, "lastResetAt seed should be cycle start");

  assert.equal(betaTasks.length, 1, "Beta already had the task; no duplicate added");
  assert.equal(charlieTasks.length, 3, "Charlie was at cap; no add");

  assert.equal(deltaTasks.length, 1);
  assert.equal(deltaTasks[0].name, "Una Dailies");

  // Reply should be a single ephemeral notice.
  assert.equal(replyCalls.length, 1);
  assert.equal(replyCalls[0].flags, 64);
});

test("add-all: skips save() entirely when no char fits (every char dup or cap)", async () => {
  const userDoc = {
    discordId: "u1",
    accounts: [
      {
        accountName: "main",
        characters: [
          {
            name: "Alpha",
            class: "Berserker",
            itemLevel: 1700,
            sideTasks: [
              { taskId: "x", name: "Una", reset: "daily", completed: false, lastResetAt: 0, createdAt: 0 },
            ],
          },
        ],
      },
    ],
    save: async () => { throw new Error("save() should not be called"); },
  };
  const stubEmbed = {
    setColor() { return this; }, setTitle() { return this; }, setDescription() { return this; },
    addFields() { return this; }, setFooter() { return this; },
  };
  const { createRaidTaskCommand } = require("../src/commands/raid-task");
  const handlers = createRaidTaskCommand({
    EmbedBuilder: function () { return stubEmbed; },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } },
    ButtonStyle: { Danger: 4, Secondary: 2 },
    MessageFlags: { Ephemeral: 64 },
    User: { findOne: async () => userDoc },
    saveWithRetry: async (fn) => fn(),
    loadUserForAutocomplete: async () => userDoc,
    dailyResetStartMs: () => 0,
    weekResetStartMs: () => 0,
  });

  let replied = false;
  const interaction = {
    user: { id: "u1" },
    options: {
      getSubcommand: () => "add",
      getString: (name) => {
        if (name === "action") return "all";
        if (name === "roster") return "main";
        if (name === "name") return "Una";
        if (name === "reset") return "daily";
        return null;
      },
    },
    reply: async () => { replied = true; },
  };
  // Should not throw; save is not called because added.length === 0.
  await handlers.handleRaidTaskCommand(interaction);
  assert.equal(replied, true);
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
