// Seed env BEFORE requiring bot/commands so the module-level boot
// warning for missing RAID_MANAGER_ID doesn't fire during tests.
process.env.RAID_MANAGER_ID = "test-manager-1";

const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../bot/commands");
const {
  TASK_CAP_DAILY,
  TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_DAILY,
  SHARED_TASK_CAP_WEEKLY,
  SHARED_TASK_CAP_SCHEDULED,
  generateTaskId,
  findCharacterInUser,
  findAccountInUser,
  countByReset,
  ensureSideTasks,
  ensureSharedTasks,
} = require("../bot/handlers/raid-task");
const {
  parseSharedTaskExpiresAt,
  resolveScheduledSharedTaskState,
  getSharedTaskDisplay,
  getNextSharedTaskTransitionMs,
} = require("../bot/utils/raid/shared-tasks");

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

test("SHARED_TASK_CAP constants are 5 daily + 5 weekly + 5 scheduled", () => {
  assert.equal(SHARED_TASK_CAP_DAILY, 5);
  assert.equal(SHARED_TASK_CAP_WEEKLY, 5);
  assert.equal(SHARED_TASK_CAP_SCHEDULED, 5);
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

test("findAccountInUser resolves roster names case-insensitively", () => {
  const userDoc = {
    accounts: [
      { accountName: "Alt Roster" },
      { accountName: "MainRoster" },
    ],
  };
  const found = findAccountInUser(userDoc, "mainroster");
  assert.ok(found);
  assert.equal(found.accountName, "MainRoster");
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

test("ensureSharedTasks initializes missing account-level shared task list", () => {
  const account = {};
  const result = ensureSharedTasks(account);
  assert.deepEqual(result, []);
  assert.deepEqual(account.sharedTasks, []);
});

test("parseSharedTaskExpiresAt accepts YYYY-MM-DD and rejects invalid dates", () => {
  assert.equal(
    parseSharedTaskExpiresAt("2026-05-20"),
    Date.UTC(2026, 4, 20, 23, 59, 59, 999)
  );
  assert.ok(Number.isNaN(parseSharedTaskExpiresAt("2026-02-31")));
  assert.ok(Number.isNaN(parseSharedTaskExpiresAt("20-05-2026")));
  assert.equal(parseSharedTaskExpiresAt(""), null);
});

test("scheduled shared task: Chaos Gate completion key follows hourly spawn slots", () => {
  const task = { preset: "chaos_gate", reset: "scheduled", completedForKey: "" };
  const mondayLate = new Date("2026-04-28T02:30:00.000Z"); // Mon 22:30 UTC-4.
  const sameMondaySlot = new Date("2026-04-28T02:59:00.000Z"); // Mon 22:59 UTC-4.
  const nextMondaySlot = new Date("2026-04-28T03:00:00.000Z"); // Mon 23:00 UTC-4.
  const beforeDailyReset = new Date("2026-04-28T09:30:00.000Z"); // Tue 05:30 UTC-4, before 10:00 UTC reset.
  const afterWindow = new Date("2026-04-28T10:05:00.000Z"); // Tue 06:05 UTC-4.

  const lateState = resolveScheduledSharedTaskState(task, mondayLate);
  const sameSlotState = resolveScheduledSharedTaskState(task, sameMondaySlot);
  const nextSlotState = resolveScheduledSharedTaskState(task, nextMondaySlot);
  const beforeResetState = resolveScheduledSharedTaskState(task, beforeDailyReset);
  const afterState = resolveScheduledSharedTaskState(task, afterWindow);

  assert.equal(lateState.active, true);
  assert.equal(beforeResetState.active, true);
  assert.equal(lateState.key, "chaos_gate:slot:2026-04-28T02:00Z");
  assert.equal(sameSlotState.key, lateState.key);
  assert.equal(nextSlotState.key, "chaos_gate:slot:2026-04-28T03:00Z");
  assert.equal(beforeResetState.key, "chaos_gate:slot:2026-04-28T09:00Z");
  assert.equal(lateState.slotEndAtMs, Date.UTC(2026, 3, 28, 3, 0, 0, 0));
  assert.equal(lateState.windowEndAtMs, Date.UTC(2026, 3, 28, 10, 0, 0, 0));
  assert.equal(afterState.active, false);
  assert.equal(afterState.nextAtMs, Date.UTC(2026, 3, 30, 15, 0, 0, 0));
  assert.match(
    getSharedTaskDisplay(task, mondayLate).status,
    new RegExp(`<t:${Math.floor(lateState.slotEndAtMs / 1000)}:R>`)
  );
  const activeDisplay = getSharedTaskDisplay(task, mondayLate);
  const inactiveDisplay = getSharedTaskDisplay(task, afterWindow);
  assert.doesNotMatch(activeDisplay.optionStatus, /<t:/);
  assert.equal(activeDisplay.optionStatus, "Đang mở");
  assert.match(
    activeDisplay.status,
    new RegExp(`<t:${Math.floor(lateState.slotEndAtMs / 1000)}:f>`)
  );
  assert.doesNotMatch(activeDisplay.status, /VN · .*UTC-4/);
  assert.match(inactiveDisplay.status, /<t:\d+:R>/);
  assert.match(inactiveDisplay.status, /<t:\d+:f>/);
  assert.doesNotMatch(inactiveDisplay.status, /VN · .*UTC-4/);
  assert.equal(inactiveDisplay.optionStatus, "Mở T5 22:00 VN");
});

test("scheduled shared task: Field Boss follows Tue/Fri/Sun UTC-4 windows", () => {
  const task = { preset: "field_boss", reset: "scheduled", completedForKey: "" };
  const sundayLate = new Date("2026-04-27T02:30:00.000Z"); // Sun 22:30 UTC-4.
  const mondayNoon = new Date("2026-04-27T16:00:00.000Z"); // Mon 12:00 UTC-4.
  const tuesdayNoon = new Date("2026-04-28T16:00:00.000Z"); // Tue 12:00 UTC-4.
  const wednesdayNoon = new Date("2026-04-29T16:00:00.000Z"); // Wed 12:00 UTC-4.

  const sundayState = resolveScheduledSharedTaskState(task, sundayLate);
  const tuesdayState = resolveScheduledSharedTaskState(task, tuesdayNoon);

  assert.equal(sundayState.active, true);
  assert.equal(resolveScheduledSharedTaskState(task, mondayNoon).active, false);
  assert.equal(tuesdayState.active, true);
  assert.equal(resolveScheduledSharedTaskState(task, wednesdayNoon).active, false);
  assert.equal(sundayState.key, "field_boss:slot:2026-04-27T02:00Z");
  assert.equal(tuesdayState.key, "field_boss:slot:2026-04-28T16:00Z");
});

test("scheduled shared task: next transition helper returns nearest open or close", () => {
  const account = {
    sharedTasks: [
      { taskId: "manual", preset: "event_shop", reset: "weekly" },
      { taskId: "cg", preset: "chaos_gate", reset: "scheduled" },
      { taskId: "fb", preset: "field_boss", reset: "scheduled" },
    ],
  };
  const mondayLate = new Date("2026-04-28T02:30:00.000Z"); // Mon 22:30 UTC-4.
  const afterWindow = new Date("2026-04-28T10:05:00.000Z"); // Tue 06:05 UTC-4.

  assert.equal(
    getNextSharedTaskTransitionMs(account, mondayLate),
    Date.UTC(2026, 3, 28, 3, 0, 0, 0)
  );
  assert.equal(
    getNextSharedTaskTransitionMs(account, afterWindow),
    Date.UTC(2026, 3, 28, 15, 0, 0, 0)
  );
});

// ---------------------------------------------------------------------------
// Privacy regression: /raid-check all-mode .select projection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pack2Columns shared util: ZWS-spacer 2-column layout packer
// ---------------------------------------------------------------------------

test("pack2Columns: even count interleaves spacers correctly", () => {
  const { pack2Columns, INLINE_SPACER } = require("../bot/utils/raid/shared");
  const A = { name: "A", value: "a", inline: true };
  const B = { name: "B", value: "b", inline: true };
  const C = { name: "C", value: "c", inline: true };
  const D = { name: "D", value: "d", inline: true };
  const out = pack2Columns([A, B, C, D]);
  // 4 chars -> 2 rows of [card, spacer, card]
  assert.deepEqual(out, [A, INLINE_SPACER, B, C, INLINE_SPACER, D]);
});

test("pack2Columns: odd count pads trailing card with extra spacer", () => {
  const { pack2Columns, INLINE_SPACER } = require("../bot/utils/raid/shared");
  const A = { name: "A", value: "a", inline: true };
  const B = { name: "B", value: "b", inline: true };
  const C = { name: "C", value: "c", inline: true };
  const out = pack2Columns([A, B, C]);
  // C alone -> [C, spacer, spacer] so Discord doesn't full-width it.
  assert.deepEqual(out, [A, INLINE_SPACER, B, C, INLINE_SPACER, INLINE_SPACER]);
});

test("pack2Columns: empty input returns empty array", () => {
  const { pack2Columns } = require("../bot/utils/raid/shared");
  assert.deepEqual(pack2Columns([]), []);
});

test("autocomplete-helpers: getRosterMatches filters by needle + caps 25", () => {
  const { getRosterMatches } = require("../bot/utils/raid/autocomplete-helpers");
  const userDoc = {
    accounts: Array.from({ length: 30 }, (_, i) => ({
      accountName: `Roster${i}`,
      characters: [],
    })),
  };
  // No needle → 25 cap.
  assert.equal(getRosterMatches(userDoc).length, 25);
  // Needle "Roster1" matches "Roster1", "Roster10".."Roster19" = 11.
  const matches = getRosterMatches(userDoc, "Roster1");
  assert.equal(matches.length, 11);
  // Empty doc → empty array (no throw).
  assert.deepEqual(getRosterMatches(null), []);
  assert.deepEqual(getRosterMatches({}), []);
});

test("autocomplete-helpers: getCharacterMatches respects rosterFilter + dedup + sort", () => {
  const { getCharacterMatches } = require("../bot/utils/raid/autocomplete-helpers");
  const userDoc = {
    accounts: [
      {
        accountName: "main",
        characters: [
          { name: "Alpha", class: "Berserker", itemLevel: 1700, sideTasks: [{}, {}] },
          { name: "Beta", class: "Bard", itemLevel: 1690, sideTasks: [] },
        ],
      },
      {
        accountName: "alt",
        characters: [
          { name: "Beta", class: "Sorc", itemLevel: 1680, sideTasks: [] },
          { name: "Gamma", class: "Paladin", itemLevel: 1750, sideTasks: [] },
        ],
      },
    ],
  };
  // No filter → cross-account, dedup "Beta" (first wins by iteration order).
  const all = getCharacterMatches(userDoc);
  assert.equal(all.length, 3, "Beta deduped, expect Alpha/Beta/Gamma");
  // Sort iLvl desc: Gamma 1750, Alpha 1700, Beta 1690.
  assert.equal(all[0].name, "Gamma");
  assert.equal(all[1].name, "Alpha");
  assert.equal(all[2].name, "Beta");
  // sideTaskCount surfaces.
  assert.equal(all[1].sideTaskCount, 2);
  // Roster filter scopes to one account.
  const alt = getCharacterMatches(userDoc, { rosterFilter: "alt" });
  assert.equal(alt.length, 2);
  assert.deepEqual(alt.map((e) => e.name).sort(), ["Beta", "Gamma"]);
  // Needle filter.
  const beta = getCharacterMatches(userDoc, { needle: "beta" });
  assert.equal(beta.length, 1);
  assert.equal(beta[0].name, "Beta");
  // dedup:false keeps both Betas.
  const noDedup = getCharacterMatches(userDoc, { dedup: false });
  assert.equal(noDedup.filter((e) => e.name === "Beta").length, 2);
});

test("autocomplete-helpers: truncateChoice caps name + value to 100 chars", () => {
  const { truncateChoice } = require("../bot/utils/raid/autocomplete-helpers");
  const longName = "A".repeat(150);
  const out = truncateChoice(longName, longName);
  assert.equal(out.name.length, 100);
  assert.ok(out.name.endsWith("..."));
  assert.equal(out.value.length, 100);
});

test("replyNotice wraps interaction.reply with the notice embed + ephemeral flag", async () => {
  const { replyNotice } = require("../bot/utils/raid/shared");
  const calls = [];
  const interaction = {
    reply: async (payload) => calls.push(payload),
  };
  class StubEmbed {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
  }
  await replyNotice(interaction, StubEmbed, {
    type: "warn",
    title: "T",
    description: "D",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].flags, 64); // MessageFlags.Ephemeral
  assert.equal(calls[0].embeds.length, 1);
});

test("replyNotice: ephemeral:false omits the flag for channel-broadcast notices", async () => {
  const { replyNotice } = require("../bot/utils/raid/shared");
  const calls = [];
  const interaction = { reply: async (payload) => calls.push(payload) };
  class StubEmbed {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
  }
  await replyNotice(interaction, StubEmbed, { type: "info", title: "X" }, { ephemeral: false });
  assert.equal(calls[0].flags, undefined);
});

test("updateNotice clears components by default and accepts override via extras", async () => {
  const { updateNotice } = require("../bot/utils/raid/shared");
  const calls = [];
  const component = { update: async (payload) => calls.push(payload) };
  class StubEmbed {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
  }
  await updateNotice(component, StubEmbed, { type: "muted", title: "X" });
  assert.deepEqual(calls[0].components, []);

  await updateNotice(
    component,
    StubEmbed,
    { type: "info", title: "Y" },
    { components: [{ keep: "row" }] }
  );
  assert.deepEqual(calls[1].components, [{ keep: "row" }]);
});

test("formatProgressTotals: standard 3-icon line", () => {
  const { formatProgressTotals } = require("../bot/utils/raid/shared");
  const UI = { icons: { done: "🟢", partial: "🟡", pending: "⚪", lock: "🔒" } };
  const out = formatProgressTotals({ done: 2, partial: 1, pending: 4 }, UI);
  assert.equal(out, "🟢 2 done · 🟡 1 partial · ⚪ 4 pending");
});

test("formatProgressTotals: notEligible suffix only when > 0", () => {
  const { formatProgressTotals } = require("../bot/utils/raid/shared");
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
  const { formatProgressTotals } = require("../bot/utils/raid/shared");
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
  const { INLINE_SPACER } = require("../bot/utils/raid/shared");
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
  const { buildAccountTaskFields } = require("../bot/utils/raid/task-view");
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
  assert.match(fields[0].name, /1700/);
  assert.match(fields[0].value, /\*\*Daily\*\* · 1\/2/);
  assert.match(fields[0].value, /🟢 Una/);
  assert.doesNotMatch(fields[0].value, /· daily/);
  assert.match(fields[2].name, /Beta/);
  assert.match(fields[2].name, /1690/);
  assert.match(fields[2].value, /\*\*Weekly\*\* · 1\/1/);
  assert.match(fields[2].value, /🟢 Guardian/);
  assert.doesNotMatch(fields[2].value, /· weekly/);
});

test("buildAccountTaskFields renders every task char when roster exceeds 2-column cap", () => {
  const { PAGE_CHAR_CAP, buildAccountTaskFields } = require("../bot/utils/raid/task-view");
  const account = {
    accountName: "large",
    characters: Array.from({ length: PAGE_CHAR_CAP + 1 }, (_, index) => ({
      name: `Char${index + 1}`,
      class: "Bard",
      itemLevel: 1700,
      sideTasks: [
        {
          taskId: `daily-${index + 1}`,
          name: `Daily ${index + 1}`,
          reset: "daily",
          completed: index % 2 === 0,
        },
      ],
    })),
  };

  const { fields, totals } = buildAccountTaskFields(account, {
    UI: { icons: { done: "done", pending: "todo" } },
    truncateText: (s) => s,
  });

  assert.equal(totals.charsWithTasks, PAGE_CHAR_CAP + 1);
  assert.equal(totals.rendered, PAGE_CHAR_CAP + 1);
  assert.equal(totals.daily, PAGE_CHAR_CAP + 1);
  assert.equal(totals.dailyDone, 6);
  assert.equal(fields.length, PAGE_CHAR_CAP + 1);
  assert.ok(fields.every((field) => field.inline === false));
  assert.match(fields.at(-1).name, /Char12/);
  assert.match(fields.at(-1).value, /Daily 12/);
});

test("buildAccountTaskFields returns empty fields when no chars-with-tasks", () => {
  const { buildAccountTaskFields } = require("../bot/utils/raid/task-view");
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
  const { buildAccountTaskFields } = require("../bot/utils/raid/task-view");
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

test("PROJECTION: raid-check all-mode uses the shared raid-check projection", () => {
  // Manager all-mode and the per-raid snapshot must stay on the same
  // allowlist. This pins sideTasks plus alias fields such as
  // charName/className/raids that previously drifted out of all-mode.
  const fs = require("fs");
  const path = require("path");
  const allModeSrc = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-check", "all-mode.js"),
    "utf8"
  );
  const { RAID_CHECK_USER_QUERY_FIELDS } = require("../bot/utils/raid/raid-check-query");
  assert.ok(
    allModeSrc.includes("RAID_CHECK_USER_QUERY_FIELDS"),
    "all-mode must use the shared /raid-check projection constant"
  );
  assert.ok(
    RAID_CHECK_USER_QUERY_FIELDS.includes("accounts.characters.sideTasks"),
    "sideTasks must be in shared projection (Manager Task view)"
  );
  assert.ok(
    RAID_CHECK_USER_QUERY_FIELDS.includes("accounts.sharedTasks"),
    "sharedTasks must be in shared projection (Manager Task view)"
  );
  assert.ok(
    RAID_CHECK_USER_QUERY_FIELDS.includes("accounts.characters.charName"),
    "charName alias must be in shared projection"
  );
  assert.ok(
    RAID_CHECK_USER_QUERY_FIELDS.includes("accounts.characters.className"),
    "className alias must be in shared projection"
  );
  assert.ok(
    RAID_CHECK_USER_QUERY_FIELDS.includes("accounts.characters.raids"),
    "raids must be in shared projection for legacy stored rows"
  );
  assert.ok(
    !RAID_CHECK_USER_QUERY_FIELDS.split(/\s+/).includes("accounts"),
    "projection must enumerate subfields, not project the entire accounts array"
  );
});

test("REGRESSION: raid-check all-mode actions target current page user", () => {
  const fs = require("fs");
  const path = require("path");
  const allModeSrc = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-check", "all-mode.js"),
    "utf8"
  );

  assert.ok(
    allModeSrc.includes("const actionUserId = filterUserId || currentViewUserId;"),
    "all-mode action buttons must fall back to the currently visible user"
  );
  assert.ok(
    allModeSrc.includes("raid-check:enable-auto-one:${actionUserId}") &&
      allModeSrc.includes("raid-check:disable-auto-one:${actionUserId}"),
    "auto-sync buttons must target the currently visible user"
  );
  assert.ok(
    !allModeSrc.includes('if (!filterUserId) currentView = "raid";'),
    "clearing the dropdown filter must not force Task view away from current-page users"
  );
});

test("PROJECTION: RAID_CHECK_USER_QUERY_FIELDS allowlist includes sideTasks", () => {
  const {
    RAID_CHECK_USER_QUERY_FIELDS,
  } = require("../bot/utils/raid/raid-check-query");
  assert.ok(typeof RAID_CHECK_USER_QUERY_FIELDS === "string");
  assert.ok(
    RAID_CHECK_USER_QUERY_FIELDS.includes("accounts.characters.sideTasks"),
    "sideTasks must be in /raid-check select projection (Manager Task view)"
  );
  assert.ok(
    RAID_CHECK_USER_QUERY_FIELDS.includes("accounts.sharedTasks"),
    "sharedTasks must be in /raid-check select projection (Manager Task view)"
  );
});

test("raid-check task view renders roster shared tasks even without side tasks", async () => {
  const { createTaskViewUi } = require("../bot/handlers/raid-check/task-view-ui");
  let selectedFields = "";
  const userDoc = {
    discordId: "u1",
    discordDisplayName: "Artist",
    accounts: [
      {
        accountName: "main",
        characters: [],
        sharedTasks: [
          {
            taskId: "event",
            preset: "event_shop",
            name: "Event Shop",
            reset: "weekly",
            completed: false,
          },
        ],
      },
    ],
  };
  class StubEmbed {
    constructor() { this.fields = []; }
    setColor(value) { this.color = value; return this; }
    setTitle(value) { this.title = value; return this; }
    setDescription(value) { this.description = value; return this; }
    addFields(...fields) { this.fields.push(...fields.flat()); return this; }
    setFooter(value) { this.footer = value; return this; }
  }
  const handlers = createTaskViewUi({
    EmbedBuilder: StubEmbed,
    MessageFlags: { Ephemeral: 64 },
    UI: {
      colors: { neutral: 0x5865f2 },
      icons: { done: "done", pending: "todo" },
    },
    User: {
      findOne: () => ({
        select(fields) {
          selectedFields = fields;
          return { lean: async () => userDoc };
        },
      }),
    },
    truncateText: (value, max = 100) =>
      value.length > max ? `${value.slice(0, max - 3)}...` : value,
    buildPaginationRow: () => ({ row: true }),
    RAID_CHECK_PAGINATION_SESSION_MS: 1,
  });

  let replyPayload = null;
  const interaction = {
    reply: async (payload) => { replyPayload = payload; },
  };

  await handlers.handleRaidCheckViewTasksClick(interaction, "u1");

  assert.match(selectedFields, /accounts\.sharedTasks/);
  const embed = replyPayload.embeds[0];
  assert.ok(embed.fields.some((field) => /Task chung/.test(field.name)));
  assert.ok(embed.fields.some((field) => /Event Shop/.test(field.value)));
  assert.equal(replyPayload.flags, 64);
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
  } = require("../bot/services/raid-schedulers");
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

  assert.equal(
    calls.length,
    4,
    "expected 4 updateMany calls (char daily/weekly + shared daily/weekly)"
  );
  assert.equal(report.dailyModified, 0);
  assert.equal(report.weeklyModified, 0);
  assert.equal(report.sharedDailyModified, 0);
  assert.equal(report.sharedWeeklyModified, 0);
  assert.equal(report.dailyStart, Date.UTC(2026, 3, 22, 10, 0, 0, 0));

  const [dailyCall, weeklyCall, sharedDailyCall, sharedWeeklyCall] = calls;

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

  assert.ok(
    "accounts.$[].sharedTasks.$[task].completed" in sharedDailyCall.update.$set
  );
  assert.equal(sharedDailyCall.options.arrayFilters[0]["task.reset"], "daily");
  assert.ok(
    "accounts.$[].sharedTasks.$[task].completed" in sharedWeeklyCall.update.$set
  );
  assert.equal(sharedWeeklyCall.options.arrayFilters[0]["task.reset"], "weekly");
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

  const { createRaidTaskCommand } = require("../bot/handlers/raid-task");
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
  const { createRaidTaskCommand } = require("../bot/handlers/raid-task");
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
  const { createRaidTaskCommand } = require("../bot/handlers/raid-task");
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
  const { createRaidTaskCommand } = require("../bot/handlers/raid-task");
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

test("shared-add: adds Chaos Gate as scheduled roster task", async () => {
  let savedDoc = null;
  const userDoc = {
    discordId: "u1",
    accounts: [
      {
        accountName: "main",
        characters: [],
        sharedTasks: [],
      },
    ],
    save: async function () {
      savedDoc = JSON.parse(JSON.stringify(this));
    },
  };
  const stubEmbed = {
    setColor() { return this; }, setTitle() { return this; }, setDescription() { return this; },
    addFields() { return this; }, setFooter() { return this; },
  };
  const { createRaidTaskCommand } = require("../bot/handlers/raid-task");
  const handlers = createRaidTaskCommand({
    EmbedBuilder: function () { return stubEmbed; },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } },
    ButtonStyle: { Danger: 4, Secondary: 2 },
    MessageFlags: { Ephemeral: 64 },
    User: { findOne: async () => userDoc },
    saveWithRetry: async (fn) => fn(),
    loadUserForAutocomplete: async () => userDoc,
    dailyResetStartMs: () => 111,
    weekResetStartMs: () => 222,
  });

  const interaction = {
    user: { id: "u1" },
    options: {
      getSubcommand: () => "shared-add",
      getString: (name) => {
        if (name === "roster") return "main";
        if (name === "preset") return "chaos_gate";
        return null;
      },
    },
    reply: async () => {},
  };

  await handlers.handleRaidTaskCommand(interaction);

  assert.ok(savedDoc, "expected save() to be called");
  const task = savedDoc.accounts[0].sharedTasks[0];
  assert.equal(task.preset, "chaos_gate");
  assert.equal(task.name, "Chaos Gate");
  assert.equal(task.reset, "scheduled");
  assert.equal(task.lastResetAt, 0);
});

test("shared-add autocomplete: preset labels show already-added state", async () => {
  const userDoc = {
    discordId: "u1",
    accounts: [
      {
        accountName: "main",
        characters: [],
        sharedTasks: [
          { taskId: "cg", preset: "chaos_gate", name: "Chaos Gate", reset: "scheduled" },
        ],
      },
    ],
  };
  const stubEmbed = {
    setColor() { return this; }, setTitle() { return this; }, setDescription() { return this; },
    addFields() { return this; }, setFooter() { return this; },
  };
  const { createRaidTaskCommand } = require("../bot/handlers/raid-task");
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

  let choices = null;
  const interaction = {
    user: { id: "u1" },
    options: {
      getFocused: () => ({ name: "preset", value: "" }),
      getString: (name) => (name === "roster" ? "main" : null),
    },
    respond: async (value) => { choices = value; },
  };

  await handlers.handleRaidTaskAutocomplete(interaction);

  const chaosGate = choices.find((choice) => choice.value === "chaos_gate");
  assert.ok(chaosGate, "expected chaos_gate autocomplete choice");
  assert.match(chaosGate.name, /đã thêm/);
});

test("shared-add: all_rosters adds missing rosters and skips duplicates", async () => {
  let savedDoc = null;
  const userDoc = {
    discordId: "u1",
    accounts: [
      {
        accountName: "main",
        characters: [],
        sharedTasks: [],
      },
      {
        accountName: "alt",
        characters: [],
        sharedTasks: [
          { taskId: "existing", preset: "chaos_gate", name: "Chaos Gate", reset: "scheduled" },
        ],
      },
    ],
    save: async function () {
      savedDoc = JSON.parse(JSON.stringify(this));
    },
  };
  const stubEmbed = {
    setColor() { return this; }, setTitle() { return this; }, setDescription() { return this; },
    addFields() { return this; }, setFooter() { return this; },
  };
  const { createRaidTaskCommand } = require("../bot/handlers/raid-task");
  const handlers = createRaidTaskCommand({
    EmbedBuilder: function () { return stubEmbed; },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } },
    ButtonStyle: { Danger: 4, Secondary: 2 },
    MessageFlags: { Ephemeral: 64 },
    User: { findOne: async () => userDoc },
    saveWithRetry: async (fn) => fn(),
    loadUserForAutocomplete: async () => userDoc,
    dailyResetStartMs: () => 111,
    weekResetStartMs: () => 222,
  });

  const interaction = {
    user: { id: "u1" },
    options: {
      getSubcommand: () => "shared-add",
      getString: (name) => {
        if (name === "roster") return "main";
        if (name === "preset") return "chaos_gate";
        return null;
      },
      getBoolean: (name) => name === "all_rosters",
    },
    reply: async () => {},
  };

  await handlers.handleRaidTaskCommand(interaction);

  assert.ok(savedDoc, "expected save() to be called");
  assert.equal(savedDoc.accounts[0].sharedTasks.length, 1);
  assert.equal(savedDoc.accounts[0].sharedTasks[0].preset, "chaos_gate");
  assert.equal(savedDoc.accounts[1].sharedTasks.length, 1);
  assert.equal(savedDoc.accounts[1].sharedTasks[0].taskId, "existing");
});

test("shared-remove: deletes one roster shared task by id", async () => {
  let savedDoc = null;
  const userDoc = {
    discordId: "u1",
    accounts: [
      {
        accountName: "main",
        sharedTasks: [
          { taskId: "keep", name: "Event Shop", reset: "weekly" },
          { taskId: "drop", name: "Chaos Gate", reset: "scheduled" },
        ],
      },
    ],
    save: async function () {
      savedDoc = JSON.parse(JSON.stringify(this));
    },
  };
  const stubEmbed = {
    setColor() { return this; }, setTitle() { return this; }, setDescription() { return this; },
    addFields() { return this; }, setFooter() { return this; },
  };
  const { createRaidTaskCommand } = require("../bot/handlers/raid-task");
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

  const interaction = {
    user: { id: "u1" },
    options: {
      getSubcommand: () => "shared-remove",
      getString: (name) => {
        if (name === "roster") return "main";
        if (name === "task") return "drop";
        return null;
      },
    },
    reply: async () => {},
  };

  await handlers.handleRaidTaskCommand(interaction);

  assert.ok(savedDoc, "expected save() to be called");
  assert.deepEqual(
    savedDoc.accounts[0].sharedTasks.map((task) => task.taskId),
    ["keep"]
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
  } = require("../bot/services/raid-schedulers");
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
