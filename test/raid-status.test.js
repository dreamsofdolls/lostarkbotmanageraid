// Tests for /raid-status pure render helpers.
//
// Focus on the embed-shape contracts that have caused regressions in
// the past: footer roll-up math (done/partial/pending counts), page
// counter only when totalPages > 1, hideIneligibleChars filter
// behavior, and the not-eligible empty-roster notice path.
//
// handleStatusCommand itself is not exercised here — too coupled to
// the Discord interaction lifecycle (defer/edit/collector). The
// surface that matters for rendering bugs is the helper layer.

process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EmbedBuilder,
  ComponentType,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { createRaidStatusCommand } = require("../bot/handlers/raid-status");
const { createRaidStatusTaskUi } = require("../bot/handlers/raid-status/task-ui");
const {
  UI,
  truncateText,
  formatShortRelative,
  formatNextCooldownRemaining,
  waitWithBudget,
  getCharacterName,
} = require("../bot/utils/raid/shared");
const {
  summarizeRaidProgress,
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
  ensureAssignedRaids,
  RAID_REQUIREMENT_MAP,
} = require("../bot/utils/raid/character");
const { getAutoManageCooldownMs, isManagerId } = require("../bot/services/manager");

function makeFactory() {
  return createRaidStatusCommand({
    EmbedBuilder,
    ComponentType,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    UI,
    User: {},
    saveWithRetry: async (op) => op(),
    ensureFreshWeek: () => false,
    getCharacterName,
    truncateText,
    formatShortRelative,
    formatNextCooldownRemaining,
    waitWithBudget,
    summarizeRaidProgress,
    formatRaidStatusLine,
    getStatusRaidsForCharacter,
    buildPaginationRow: () => new ActionRowBuilder(),
    collectStaleAccountRefreshes: async () => [],
    applyStaleAccountRefreshes: () => false,
    formatRosterRefreshCooldownRemaining: () => null,
    acquireAutoManageSyncSlot: async () => ({ acquired: false }),
    releaseAutoManageSyncSlot: () => {},
    gatherAutoManageLogsForUserDoc: async () => null,
    applyAutoManageCollected: () => ({ perChar: [] }),
    applyAutoManageCollectedForStatus: () => ({ perChar: [] }),
    stampAutoManageAttempt: async () => {},
    weekResetStartMs: () => 0,
    AUTO_MANAGE_SYNC_COOLDOWN_MS: 10 * 60 * 1000,
    getAutoManageCooldownMs,
    isManagerId,
  });
}

const { buildStatusFooterText, buildAccountPageEmbed } = makeFactory();

// --------- buildStatusFooterText ---------

test("buildStatusFooterText: zero totals reads as 0/0/0 with no page counter", () => {
  const text = buildStatusFooterText({ progress: { completed: 0, partial: 0, total: 0 } });
  assert.match(text, /0 done/);
  assert.match(text, /0 partial/);
  assert.match(text, /0 pending/);
  assert.doesNotMatch(text, /Page/);
});

test("buildStatusFooterText: derives pending = total - completed - partial", () => {
  const text = buildStatusFooterText({ progress: { completed: 3, partial: 2, total: 10 } });
  // 10 - 3 - 2 = 5 pending
  assert.match(text, /3 done/);
  assert.match(text, /2 partial/);
  assert.match(text, /5 pending/);
});

test("buildStatusFooterText: clamps negative pending to 0 (defense against bad inputs)", () => {
  // Defensive: if completed + partial > total (data corruption / future
  // schema change), pending must not surface as a negative number.
  const text = buildStatusFooterText({ progress: { completed: 5, partial: 5, total: 8 } });
  assert.match(text, /0 pending/);
});

test("buildStatusFooterText: page counter appears only when totalPages > 1", () => {
  const single = buildStatusFooterText(
    { progress: { completed: 1, partial: 0, total: 1 } },
    { pageIndex: 0, totalPages: 1 }
  );
  assert.doesNotMatch(single, /Page/);

  const multi = buildStatusFooterText(
    { progress: { completed: 1, partial: 0, total: 1 } },
    { pageIndex: 1, totalPages: 3 }
  );
  assert.match(multi, /Page 2\/3/);
});

test("buildStatusFooterText: handles missing progress field defensively", () => {
  // Some upstream paths build globalTotals without a progress key
  // (early-return cases). Helper must default everything to 0.
  const text = buildStatusFooterText({});
  assert.match(text, /0 done/);
  assert.match(text, /0 pending/);
});

// --------- buildAccountPageEmbed ---------

function makeChar(name, itemLevel) {
  return {
    id: `${name}-id`,
    name,
    class: "Bard",
    itemLevel,
    assignedRaids: ensureAssignedRaids({}),
    tasks: [],
  };
}

const NOOP_GET_RAIDS_FOR = () => [];

test("buildAccountPageEmbed: empty roster surfaces an explicit notice (not a blank embed)", () => {
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0, // pageIndex
    1, // totalPages
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 0 },
    NOOP_GET_RAIDS_FOR
  );
  const json = embed.toJSON();
  // Title carries the account name + roster header icon.
  assert.match(json.title, /Alpha/);
  // Either a description note or a fields entry should signal the empty state.
  const hasEmptyNotice =
    /No characters/i.test(json.description || "") ||
    (json.fields || []).some((f) => /No characters/i.test(f.value));
  assert.ok(hasEmptyNotice, "empty roster should render a 'No characters' notice");
});

test("buildAccountPageEmbed: title icon flips to 'done' when every raid is completed", () => {
  // 1 char, 1 raid, fully done → title prefixed with the green-check icon.
  const char = makeChar("Cyrano", 1730);
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  const fakeRaid = {
    raidKey: "kazeros_hard",
    raidLabel: "Kazeros Hard",
    completed: true,
    inProgress: false,
    isCompleted: true,
    color: 0x57f287,
  };
  const getRaidsFor = () => [fakeRaid];

  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 1, partial: 0, total: 1 }, characters: 1 },
    getRaidsFor
  );
  const json = embed.toJSON();
  // Done icon = 🟢
  assert.match(json.title, /🟢/);
});

test("buildAccountPageEmbed: title icon = 'lock' when no eligible raids exist on the roster", () => {
  // Single low-iLvl char that's not eligible for anything → roster
  // progress.total = 0 → lock icon at the title.
  const char = makeChar("LowGear", 1500);
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };

  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 1 },
    NOOP_GET_RAIDS_FOR
  );
  assert.match(embed.toJSON().title, /🔒/);
});

test("buildAccountPageEmbed: page counter shows in footer when totalPages > 1", () => {
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    1, // pageIndex (0-based, so display = 2)
    3, // totalPages
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 0 },
    NOOP_GET_RAIDS_FOR
  );
  assert.match(embed.toJSON().footer.text, /Page 2\/3/);
});

test("buildAccountPageEmbed: includes 'All accounts' rollup line in description when paginating", () => {
  // Multi-account caller flips between pages; the cross-account rollup
  // helps them keep a sense of overall progress.
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    3,
    { progress: { completed: 5, partial: 1, total: 8 }, characters: 12 },
    NOOP_GET_RAIDS_FOR
  );
  const json = embed.toJSON();
  assert.match(json.description, /All accounts/);
  assert.match(json.description, /12.*chars/);
  assert.match(json.description, /5\/8/);
});

test("buildAccountPageEmbed: omits 'All accounts' rollup on a single-page roster", () => {
  // No need for the cross-account context when there's only one page.
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 0 },
    NOOP_GET_RAIDS_FOR
  );
  const desc = embed.toJSON().description || "";
  assert.doesNotMatch(desc, /All accounts/);
});

test("buildAccountPageEmbed: hideIneligibleChars filter swaps roster body for an empty notice when all chars filtered out", () => {
  // A raid filter is active; every char is ineligible for the picked
  // raid; embed body should NOT show 'No characters saved' (which
  // means roster is empty) — it should show the ineligible-for-this-raid
  // notice so the user knows there's a filter in play.
  const char = makeChar("Cyrano", 1700);
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  // getRaidsFor returns [] for every char → with hideIneligibleChars true,
  // every char drops out.
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 1 },
    NOOP_GET_RAIDS_FOR,
    null,
    { hideIneligibleChars: true }
  );
  const json = embed.toJSON();
  const hasIneligibleNotice = (json.fields || []).some((f) =>
    /eligible/i.test(f.value || "")
  );
  assert.ok(hasIneligibleNotice, "should surface an 'ineligible for this raid' notice");
});

test("buildAccountPageEmbed: roster header icon swaps to 👑 for a Manager-owned roster", () => {
  // Manager privilege visual cue. isManagerId hits the env-allowlist
  // (RAID_MANAGER_ID seeded at the top of this file).
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 0 },
    NOOP_GET_RAIDS_FOR,
    { discordId: "test-manager" } // manager
  );
  assert.match(embed.toJSON().title, /👑/);
});

test("buildAccountPageEmbed: roster header icon stays 📥 for a non-Manager roster", () => {
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 0 },
    NOOP_GET_RAIDS_FOR,
    { discordId: "regular-user" }
  );
  assert.match(embed.toJSON().title, /📥/);
  assert.doesNotMatch(embed.toJSON().title, /👑/);
});

// --------- Auto-sync OFF badge (added 2026-04-27) ---------
//
// The badge is the only visual cue that distinguishes a non-opted-in
// user from an opted-in-but-never-synced user, so it has to render only
// when the flag is explicitly false. Strict `=== false` matters for
// legacy docs where autoManageEnabled is undefined - those should NOT
// show OFF (we don't know the user's intent yet).

test("buildAccountPageEmbed: appends ' · 📝 Auto-sync OFF' badge to title when autoManageEnabled === false", () => {
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 0 },
    NOOP_GET_RAIDS_FOR,
    { discordId: "regular-user", autoManageEnabled: false }
  );
  assert.match(embed.toJSON().title, /· 📝 Auto-sync OFF/);
});

test("buildAccountPageEmbed: omits Auto-sync OFF badge when autoManageEnabled === true (silent on opted-in)", () => {
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 0 },
    NOOP_GET_RAIDS_FOR,
    { discordId: "regular-user", autoManageEnabled: true }
  );
  assert.doesNotMatch(embed.toJSON().title, /Auto-sync OFF/);
});

test("buildAccountPageEmbed: omits Auto-sync OFF badge for legacy doc with undefined autoManageEnabled", () => {
  // userMeta.autoManageEnabled is undefined - common for legacy User
  // docs from before /raid-auto-manage shipped. Strict `=== false`
  // means we don't false-positive into showing OFF here.
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 0 },
    NOOP_GET_RAIDS_FOR,
    { discordId: "regular-user" }
  );
  assert.doesNotMatch(embed.toJSON().title, /Auto-sync OFF/);
});

test("raid-status task view uses unique custom ids for shared and side task dropdowns", () => {
  const accounts = [
    {
      accountName: "Qilynn",
      sharedTasks: [
        {
          taskId: "shared-1",
          name: "Solo shop",
          reset: "weekly",
          completed: false,
        },
      ],
      characters: [
        {
          name: "Qilynn",
          class: "Artist",
          itemLevel: 1745,
          sideTasks: [
            {
              taskId: "side-1",
              name: "Paradise",
              reset: "weekly",
              completed: false,
            },
          ],
        },
      ],
    },
  ];
  const taskUi = createRaidStatusTaskUi({
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    getCharacterName,
    truncateText,
    getAccounts: () => accounts,
    getCurrentPage: () => 0,
    getCurrentView: () => "task",
    getTaskCharFilter: () => undefined,
  });

  const rows = [
    taskUi.buildSharedTaskToggleRow(false),
    taskUi.buildTaskCharFilterRow(false),
    taskUi.buildTaskToggleRow(false),
  ].filter(Boolean);
  const customIds = rows.map((row) => row.toJSON().components[0].custom_id);

  assert.deepEqual(customIds, [
    "status-task:shared-toggle",
    "status-task:char-filter",
    "status-task:toggle",
  ]);
  assert.equal(new Set(customIds).size, customIds.length);
});
