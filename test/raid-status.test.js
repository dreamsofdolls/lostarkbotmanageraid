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
const fs = require("node:fs");
const path = require("node:path");

const {
  EmbedBuilder,
  ComponentType,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const {
  createRaidStatusCommand,
  _resolveBackgroundLookup,
} = require("../bot/handlers/raid-status");
const {
  createRaidStatusRenderPayload,
} = require("../bot/handlers/raid-status/view/render-payload");
const { createRaidStatusTaskUi } = require("../bot/handlers/raid-status/task/task-ui");
const { createRaidStatusGoldUi } = require("../bot/handlers/raid-status/gold/gold-ui");
const {
  UI,
  truncateText,
  formatShortRelative,
  formatNextCooldownRemaining,
  waitWithBudget,
  getCharacterName,
  formatGold,
} = require("../bot/utils/raid/common/shared");
const { getGoldForGate, getBoundGoldForGate, isGoldBound, compareRaidModeOrder } = require("../bot/domain/raid-catalog");
const { buildRaidDropdownState } = require("../bot/handlers/raid-status/raid-filter");
const { getRaidModeLabel } = require("../bot/utils/raid/common/labels");
const {
  summarizeRaidProgress,
  summarizeAccountGold,
  summarizeGlobalGold,
  summarizeCharacterGold,
  computeRaidGold,
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
  getStatusProgressRaidsForCharacter,
  ensureAssignedRaids,
  RAID_REQUIREMENT_MAP,
} = require("../bot/utils/raid/common/character");
const { getAutoManageCooldownMs, isManagerId } = require("../bot/services/access/manager");
const { CLASS_EMOJI_MAP } = require("../bot/models/Class");

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
    summarizeAccountGold,
    summarizeGlobalGold,
    formatGold,
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
  assert.match(multi, /Trang 2\/3/);
});

test("buildStatusFooterText: handles missing progress field defensively", () => {
  // Some upstream paths build globalTotals without a progress key
  // (early-return cases). Helper must default everything to 0.
  const text = buildStatusFooterText({});
  assert.match(text, /0 done/);
  assert.match(text, /0 pending/);
});

test("REGRESSION: raid-status reload paths preserve merged shared rosters", () => {
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-status", "index.js"),
    "utf8"
  );
  const stateSource = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-status", "state", "session-state.js"),
    "utf8"
  );
  assert.match(indexSource, /const reloadViewerAccounts = async/);
  assert.match(
    stateSource,
    /accounts = await buildMergedAccounts\(discordId, userDoc\.accounts\)/
  );
  assert.doesNotMatch(stateSource, /accounts\s*=\s*userDoc\.accounts/);
  assert.doesNotMatch(stateSource, /accounts\s*=\s*reloaded\.accounts/);
});

test("REGRESSION: raid-status edit payload clears stale canvas attachments", () => {
  const renderSource = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-status", "view", "render-payload.js"),
    "utf8"
  );
  const collectorSource = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-status", "components", "component-collector.js"),
    "utf8"
  );
  assert.match(
    renderSource,
    /const payload = \{ embeds: \[embed\], files: \[\], attachments: \[\] \};/
  );
  assert.match(collectorSource, /components: buildComponents\(true\),\s+attachments: \[\],/);
});

test("REGRESSION: raid-status background renders inside the status embed below data", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "bot", "handlers", "raid-status", "view", "render-payload.js"),
    "utf8"
  );
  assert.match(source, /const attachBackgroundToStatusEmbed = \(buffer\) =>/);
  assert.match(source, /embed\.setImage\(`attachment:\/\/\$\{name\}`\);/);
  assert.doesNotMatch(source, /payload\.embeds = \[imageEmbed, embed\];/);
  assert.match(source, /payload\.files = \[\{ attachment: buffer, name \}\];/);
});

test("REGRESSION: raid-status shared roster background uses the viewer image pool", () => {
  const lookup = _resolveBackgroundLookup("viewer-b", {
    accountName: "Shared Roster",
    _sharedFrom: { ownerDiscordId: "owner-a" },
  });

  assert.equal(lookup.discordId, "viewer-b");
  assert.equal(lookup.accountName, "Shared Roster");
  assert.equal(lookup.cacheKey, "viewer-b:shared roster");
});

test("REGRESSION: raid-status progress view displays all raids but counts only gold slots", () => {
  const character = { name: "Aki" };
  const accounts = [{ accountName: "Alpha", characters: [character] }];
  const raids = [
    { raidKey: "armoche", modeKey: "normal", raidName: "Act 4 Normal", isCompleted: false, goldReceives: true },
    { raidKey: "horizon", modeKey: "normal", raidName: "Horizon Level 1", isCompleted: false, goldReceives: false },
  ];
  let capturedTotals = null;
  let capturedRaids = null;
  let capturedProgressRaids = null;

  const { buildCurrentEmbed } = createRaidStatusRenderPayload({
    discordId: "viewer",
    getAccounts: () => accounts,
    getCurrentPage: () => 0,
    getCurrentView: () => "raid",
    getFilterRaidId: () => null,
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: () => raids,
    totalCharacters: 1,
    summarizeRaidProgress: (entries) => ({ completed: 0, partial: 0, total: entries.length }),
    summarizeGlobalGold: () => ({ earned: 0, total: 0 }),
    buildAccountPageEmbed: (account, pageIndex, totalPages, globalTotals, getRaidsFor, userMeta, options) => {
      capturedTotals = globalTotals;
      capturedRaids = getRaidsFor(character);
      capturedProgressRaids = options.getProgressRaidsFor(character);
      return {};
    },
    buildGoldViewEmbed: () => ({}),
    buildTaskViewEmbed: () => ({}),
    lang: "vi",
  });

  buildCurrentEmbed();

  assert.deepEqual(capturedRaids.map((raid) => raid.raidKey), ["armoche", "horizon"]);
  assert.deepEqual(capturedProgressRaids.map((raid) => raid.raidKey), ["armoche"]);
  assert.equal(capturedTotals.progress.total, 1);
});

// --------- buildAccountPageEmbed ---------

function makeChar(name, itemLevel, options = {}) {
  return {
    id: `${name}-id`,
    name,
    class: "Bard",
    itemLevel,
    isGoldEarner: Boolean(options.isGoldEarner),
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
    /Chưa có character/i.test(json.description || "") ||
    (json.fields || []).some((f) => /Chưa có character/i.test(f.value));
  assert.ok(hasEmptyNotice, "empty roster should render a 'Chưa có character' notice");
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

test("buildAccountPageEmbed: character header uses className fallback for class emoji", () => {
  const oldBardEmoji = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = "<:bard_test:123456789012345678>";
  try {
    const char = makeChar("ClassAlias", 1710);
    delete char.class;
    char.className = "Bard";
    const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
    const embed = buildAccountPageEmbed(
      account,
      0,
      1,
      { progress: { completed: 0, partial: 0, total: 0 }, characters: 1 },
      NOOP_GET_RAIDS_FOR
    );

    assert.match(
      embed.toJSON().fields[0].name,
      /^<:bard_test:123456789012345678> ClassAlias/
    );
  } finally {
    CLASS_EMOJI_MAP.Bard = oldBardEmoji;
  }
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
  assert.match(embed.toJSON().footer.text, /Trang 2\/3/);
});

test("buildAccountPageEmbed: includes 'Tổng tất cả roster' rollup line in description when paginating", () => {
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
  assert.match(json.description, /Tổng tất cả roster/);
  assert.match(json.description, /12.*char/);
  assert.match(json.description, /5\/8/);
});

test("buildAccountPageEmbed: omits 'Tổng tất cả roster' rollup on a single-page roster", () => {
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
  assert.doesNotMatch(desc, /Tổng tất cả roster/);
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
    /đủ điều kiện/i.test(f.value || "")
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
  assert.match(embed.toJSON().title, /· 📝 Auto-sync TẮT/);
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
  assert.doesNotMatch(embed.toJSON().title, /Auto-sync TẮT/);
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
  assert.doesNotMatch(embed.toJSON().title, /Auto-sync TẮT/);
});

// --------- Gold tracking (added 2026-05-05) ---------
//
// Per (raid, mode, gate) gold values live in models/Raid.js. The view
// surfaces them in three places: per-character `💰 earned / total` line,
// per-account rollup in description, and the cross-account 🌐 line when
// paginating. All three respect the Lost Ark 6-gold-earner-per-account
// rule via `character.isGoldEarner` - non-gold-earners are excluded
// from totals and render a muted "_Not gold-earner_" line so the user
// knows the bot didn't drop them by accident.

test("formatGold: produces locale-style 'NN,NNNG' suffix and floors invalid input to 0G", () => {
  assert.equal(formatGold(26000), "26,000G");
  assert.equal(formatGold(1500), "1,500G");
  assert.equal(formatGold(0), "0G");
  assert.equal(formatGold(undefined), "0G");
  assert.equal(formatGold(NaN), "0G");
  assert.equal(formatGold(-100), "0G");
});

test("computeRaidGold: sums earned vs total across the gates of a (raid, mode)", () => {
  // Kazeros Hard G1=17000, G2=35000. Earned = G1 only = 17000.
  // Total = both gates = 52000.
  const gold = computeRaidGold("kazeros", "hard", ["G1"], ["G1", "G2"]);
  assert.equal(gold.earnedGold, 17000);
  assert.equal(gold.totalGold, 52000);
});

test("computeRaidGold: returns 0 earned when no gates cleared, full total still surfaces", () => {
  const gold = computeRaidGold("serca", "nightmare", [], ["G1", "G2"]);
  assert.equal(gold.earnedGold, 0);
  // Serca Nightmare G1=21000 + G2=33000 = 54000.
  assert.equal(gold.totalGold, 54000);
});

test("raid-catalog: normal gold splits unbound/bound; Horizon is full-bound", () => {
  // Base armoche normal G1=12500 -> 6250 unbound + 6250 bound.
  assert.equal(getGoldForGate("armoche", "normal", "G1"), 6250);
  assert.equal(getBoundGoldForGate("armoche", "normal", "G1"), 6250);
  assert.equal(getGoldForGate("armoche", "normal", "G2"), 10250);
  assert.equal(getBoundGoldForGate("armoche", "normal", "G2"), 10250);
  assert.equal(getGoldForGate("armoche", "hard", "G1"), 15000);
  assert.equal(getBoundGoldForGate("armoche", "hard", "G1"), 0);
  assert.equal(isGoldBound("armoche", "normal"), false);
  assert.equal(isGoldBound("kazeros", "normal"), false);
  assert.equal(isGoldBound("armoche", "hard"), false);
  assert.equal(isGoldBound("serca", "nightmare"), false);
  assert.equal(isGoldBound("horizon", "normal"), true);
  assert.equal(isGoldBound("horizon", "hard"), true);
  assert.equal(isGoldBound("horizon", "nightmare"), true);
  assert.equal(getGoldForGate("horizon", "normal", "G1"), 13500);
  assert.equal(getBoundGoldForGate("horizon", "normal", "G1"), 13500);
  assert.equal(getGoldForGate("horizon", "hard", "G2"), 24000);
  assert.equal(getGoldForGate("horizon", "nightmare", "G1"), 20000);
});

test("computeRaidGold: carries reduced normal bound half and Horizon full-bound", () => {
  const normal = computeRaidGold("armoche", "normal", ["G1"], ["G1", "G2"]);
  assert.equal(normal.earnedGold, 12500); // 6250 unbound + 6250 bound
  assert.equal(normal.totalGold, 33000); // full base total, split in breakdown
  assert.equal(normal.earnedBoundGold, 6250);
  assert.equal(normal.totalBoundGold, 16500);
  assert.equal(normal.goldBound, false);
  const hard = computeRaidGold("kazeros", "hard", ["G1", "G2"], ["G1", "G2"]);
  assert.equal(hard.totalGold, 52000);
  assert.equal(hard.totalBoundGold, 0);
  assert.equal(hard.goldBound, false);
  const horizon = computeRaidGold("horizon", "nightmare", ["G1"], ["G1", "G2"]);
  assert.equal(horizon.earnedGold, 20000);
  assert.equal(horizon.totalGold, 50000);
  assert.equal(horizon.earnedBoundGold, 20000);
  assert.equal(horizon.totalBoundGold, 50000);
  assert.equal(horizon.goldBound, true);
});

test("raid labels: Horizon renders with level labels only", () => {
  assert.equal(getRaidModeLabel("horizon", "normal", "vi"), "Horizon Level 1");
  assert.equal(getRaidModeLabel("horizon", "hard", "vi"), "Horizon Level 2");
  assert.equal(getRaidModeLabel("horizon", "nightmare", "vi"), "Horizon Level 3");
  assert.equal(getRaidModeLabel("kazeros", "hard", "vi"), "Kazeros Hard");
});

test("summarizeCharacterGold: splits earned/total into bound vs unbound (back-compat totals intact)", () => {
  const raids = [
    { earnedGold: 6250, totalGold: 16500, goldBound: true },   // full-bound raid
    { earnedGold: 17000, totalGold: 52000, goldBound: false }, // hard (unbound)
  ];
  const g = summarizeCharacterGold(raids);
  assert.equal(g.earned, 23250); // grand total unchanged shape
  assert.equal(g.total, 68500);
  assert.equal(g.earnedBound, 6250);
  assert.equal(g.earnedUnbound, 17000);
  assert.equal(g.totalBound, 16500);
  assert.equal(g.totalUnbound, 52000);
  assert.equal(g.earnedBound + g.earnedUnbound, g.earned);
});

test("getStatusRaidsForCharacter: decorates each raid entry with earnedGold + totalGold", () => {
  // 1730 char defaults to Hard across all 4 raids per
  // getBestEligibleModeKey logic, but only 3 raids can count gold.
  // Default un-cleared setup takes the first 3 display slots:
  // Act 4 Hard 42000 + Kazeros Hard 52000 + Serca Hard 44000 = 138000G.
  const char = makeChar("Maxlevel", 1730);
  const raids = getStatusRaidsForCharacter(char);
  assert.equal(raids.length, 4);
  for (const raid of raids) {
    assert.ok(typeof raid.earnedGold === "number", `raid ${raid.raidName} missing earnedGold`);
    assert.ok(typeof raid.totalGold === "number", `raid ${raid.raidName} missing totalGold`);
    assert.ok(typeof raid.rawTotalGold === "number", `raid ${raid.raidName} missing rawTotalGold`);
  }
  const sum = raids.reduce((acc, r) => acc + r.totalGold, 0);
  assert.equal(sum, 138000);
  const horizon = raids.find((raid) => raid.raidKey === "horizon");
  assert.equal(horizon.rawTotalGold, 40000);
  assert.equal(horizon.totalGold, 0);
  assert.equal(horizon.goldExcludedReason, "bound");
});

test("getStatusRaidsForCharacter: reduced normal raids still auto-count because they have unbound gold", () => {
  const char = makeChar("Qiaoli", 1710, { isGoldEarner: true });
  const raids = getStatusRaidsForCharacter(char);

  assert.deepEqual(
    raids.filter((raid) => raid.goldReceives).map((raid) => raid.raidKey),
    ["armoche", "kazeros", "serca"],
  );
  const horizon = raids.find((raid) => raid.raidKey === "horizon");
  assert.equal(horizon.goldReceives, false);
  assert.equal(horizon.goldExcludedReason, "bound");

  const totals = summarizeCharacterGold(raids);
  assert.equal(totals.earned, 0);
  assert.equal(totals.total, 108000);
  assert.equal(totals.totalBound, 54000);
  assert.equal(totals.totalUnbound, 54000);
});

test("getStatusProgressRaidsForCharacter: 1700 chars auto-count the only unbound gold raid", () => {
  const char = makeChar("Fresh1700", 1700, { isGoldEarner: true });
  const allRaids = getStatusRaidsForCharacter(char);
  const progressRaids = getStatusProgressRaidsForCharacter(char);

  assert.ok(allRaids.find((raid) => raid.raidKey === "horizon"), "gold setup still sees Horizon");
  assert.deepEqual(
    progressRaids.map((raid) => raid.raidKey),
    ["armoche"],
  );
  assert.equal(progressRaids[0].goldReceives, true);
});

test("getStatusRaidsForCharacter: counts the first 3 completed raids by completion time", () => {
  const char = {
    ...makeChar("FourDone", 1730),
    assignedRaids: {
      armoche: {
        modeKey: "hard",
        G1: { difficulty: "Hard", completedDate: 200 },
        G2: { difficulty: "Hard", completedDate: 200 },
      },
      kazeros: {
        modeKey: "hard",
        G1: { difficulty: "Hard", completedDate: 300 },
        G2: { difficulty: "Hard", completedDate: 300 },
      },
      serca: {
        modeKey: "hard",
        G1: { difficulty: "Hard", completedDate: 400 },
        G2: { difficulty: "Hard", completedDate: 400 },
      },
      horizon: {
        modeKey: "hard",
        G1: { difficulty: "Hard", completedDate: 100 },
        G2: { difficulty: "Hard", completedDate: 100 },
      },
    },
  };

  const raids = getStatusRaidsForCharacter(char);
  assert.deepEqual(
    raids.filter((raid) => raid.goldReceives).map((raid) => raid.raidKey),
    ["armoche", "kazeros", "serca"],
  );
  assert.equal(raids.find((raid) => raid.raidKey === "horizon").goldExcludedReason, "bound");
  assert.equal(summarizeCharacterGold(raids).earned, 138000);
});

test("getStatusRaidsForCharacter: manual goldOverride exclude keeps that raid out of gold slots", () => {
  const char = {
    ...makeChar("ManualNoGold", 1730),
    assignedRaids: {
      armoche: {},
      kazeros: {},
      serca: {},
      horizon: {
        goldOverride: "exclude",
        modeKey: "hard",
        G1: { difficulty: "Hard", completedDate: 100 },
        G2: { difficulty: "Hard", completedDate: 100 },
      },
    },
  };

  const raids = getStatusRaidsForCharacter(char);
  const horizon = raids.find((raid) => raid.raidKey === "horizon");
  assert.equal(horizon.goldDisabled, true);
  assert.equal(horizon.goldReceives, false);
  assert.equal(horizon.goldExcludedReason, "manual");
  assert.deepEqual(
    raids.filter((raid) => raid.goldReceives).map((raid) => raid.raidKey),
    ["armoche", "kazeros", "serca"],
  );
});

test("getStatusRaidsForCharacter: manual goldOverride include can count a bound raid", () => {
  const char = {
    ...makeChar("ManualBoundGold", 1730),
    assignedRaids: {
      armoche: {},
      kazeros: {},
      serca: {},
      horizon: {
        goldOverride: "include",
        modeKey: "hard",
        G1: { difficulty: "Hard", completedDate: 100 },
        G2: { difficulty: "Hard", completedDate: 100 },
      },
    },
  };

  const raids = getStatusRaidsForCharacter(char);
  const horizon = raids.find((raid) => raid.raidKey === "horizon");
  assert.equal(horizon.goldOverride, "include");
  assert.equal(horizon.goldReceives, true);
  assert.equal(horizon.goldSlotRank, 1);
  assert.equal(raids.find((raid) => raid.raidKey === "serca").goldExcludedReason, "cap");
  assert.deepEqual(
    raids.filter((raid) => raid.goldReceives).map((raid) => raid.raidKey),
    ["armoche", "kazeros", "horizon"],
  );
  assert.equal(summarizeCharacterGold(raids).total, 134000);
});

test("getStatusRaidsForCharacter: Serca 1740+ shows one mode, switching to the cleared lower mode", () => {
  const nightmareReady = makeChar("NightmareReady", 1740);
  const nightmareSerca = getStatusRaidsForCharacter(nightmareReady).filter(
    (raid) => raid.raidKey === "serca"
  );
  assert.deepEqual(
    nightmareSerca.map((raid) => raid.raidName),
    ["Serca Nightmare"]
  );

  const hardClear = {
    ...makeChar("HardClear", 1740),
    assignedRaids: {
      armoche: {},
      kazeros: {},
      serca: {
        G1: { difficulty: "Hard", completedDate: 1 },
        G2: { difficulty: "Hard", completedDate: 2 },
      },
    },
  };
  const hardSerca = getStatusRaidsForCharacter(hardClear).filter(
    (raid) => raid.raidKey === "serca"
  );
  assert.deepEqual(hardSerca.map((raid) => raid.raidName), ["Serca Hard"]);

  const normalClear = {
    ...makeChar("NormalClear", 1740),
    assignedRaids: {
      armoche: {},
      kazeros: {},
      serca: {
        G1: { difficulty: "Normal", completedDate: 1 },
        G2: { difficulty: "Normal", completedDate: 2 },
      },
    },
  };
  const normalSerca = getStatusRaidsForCharacter(normalClear).filter(
    (raid) => raid.raidKey === "serca"
  );
  assert.deepEqual(normalSerca.map((raid) => raid.raidName), ["Serca Normal"]);

  const normalPreferenceAfterReset = {
    ...makeChar("NormalPreference", 1740),
    assignedRaids: {
      armoche: {},
      kazeros: {},
      serca: {
        modeKey: "normal",
        G1: { difficulty: "Normal", completedDate: null },
        G2: { difficulty: "Normal", completedDate: null },
      },
    },
  };
  const preferredNormalSerca = getStatusRaidsForCharacter(normalPreferenceAfterReset).filter(
    (raid) => raid.raidKey === "serca"
  );
  assert.deepEqual(preferredNormalSerca.map((raid) => raid.raidName), ["Serca Normal"]);
});

test("formatRaidStatusLine: translated raid labels keep the difficulty mode", () => {
  const raid = {
    raidName: "Kazeros Hard",
    raidKey: "kazeros",
    modeKey: "hard",
    completedGateKeys: ["G1"],
    allGateKeys: ["G1", "G2"],
    isCompleted: false,
  };

  assert.match(formatRaidStatusLine(raid), /Kazeros Hard · 1\/2/);
  assert.match(formatRaidStatusLine(raid, "vi"), /Kazeros Hard · 1\/2/);
  assert.match(formatRaidStatusLine(raid, "jp"), /カゼロス ハード · 1\/2/);
  // Unbound raid: no trailing lock.
  assert.doesNotMatch(formatRaidStatusLine(raid, "vi"), new RegExp(`${UI.icons.lock}$`));
});

test("compareRaidModeOrder: canonical raid progression + difficulty order", () => {
  const shuffled = [
    { raidKey: "serca", modeKey: "hard" },
    { raidKey: "horizon", modeKey: "hard" },
    { raidKey: "armoche", modeKey: "hard" },
    { raidKey: "serca", modeKey: "normal" },
    { raidKey: "kazeros", modeKey: "normal" },
    { raidKey: "armoche", modeKey: "normal" },
  ];
  const ordered = [...shuffled].sort(compareRaidModeOrder).map((r) => `${r.raidKey}:${r.modeKey}`);
  assert.deepEqual(ordered, [
    "armoche:normal",
    "armoche:hard",
    "kazeros:normal",
    "serca:normal",
    "serca:hard",
    "horizon:hard",
  ]);
});

test("buildRaidDropdownState: orders the filter dropdown by raid progression, not pending count", () => {
  // High-backlog Serca Normal must NOT jump above Act 4 / Kazeros; a raid's
  // modes stay grouped (Serca Normal then Serca Hard).
  const raids = [
    { raidKey: "serca", modeKey: "normal", raidName: "Serca Normal", isCompleted: false },
    { raidKey: "serca", modeKey: "hard", raidName: "Serca Hard", isCompleted: false },
    { raidKey: "armoche", modeKey: "hard", raidName: "Act 4 Hard", isCompleted: false },
    { raidKey: "kazeros", modeKey: "normal", raidName: "Kazeros Normal", isCompleted: false },
    { raidKey: "horizon", modeKey: "hard", raidName: "Horizon Level 2", isCompleted: false },
  ];
  const accounts = [{ characters: [{ class: "Sorceress" }] }];
  const { raidDropdownEntries } = buildRaidDropdownState(accounts, () => raids);
  assert.deepEqual(
    raidDropdownEntries.map((r) => r.key),
    ["armoche:hard", "kazeros:normal", "serca:normal", "serca:hard", "horizon:hard"],
  );
});

test("buildRaidDropdownState: excludes raids that do not receive gold", () => {
  const raids = [
    { raidKey: "armoche", modeKey: "normal", raidName: "Act 4 Normal", isCompleted: false, goldReceives: true },
    { raidKey: "horizon", modeKey: "normal", raidName: "Horizon Level 1", isCompleted: false, goldReceives: false },
  ];
  const accounts = [{ characters: [{ class: "Sorceress" }] }];
  const { raidDropdownEntries, totalRaidPending } = buildRaidDropdownState(accounts, () => raids);

  assert.deepEqual(
    raidDropdownEntries.map((r) => r.key),
    ["armoche:normal"],
  );
  assert.equal(totalRaidPending, 1);
});

test("formatRaidStatusLine: bound-gold raids get a trailing lock", () => {
  const raid = {
    raidName: "Horizon Level 3",
    raidKey: "horizon",
    modeKey: "nightmare",
    completedGateKeys: [],
    allGateKeys: ["G1", "G2"],
    isCompleted: false,
    goldBound: true,
  };
  // The lock sits after the gate count so the main view flags roster-bound gold.
  assert.match(formatRaidStatusLine(raid, "vi"), new RegExp(`Horizon Level 3 · 0/2 ${UI.icons.lock}$`));
});

test("summarizeCharacterGold: sums earnedGold + totalGold across raid entries", () => {
  const raids = [
    { earnedGold: 17000, totalGold: 52000 },
    { earnedGold: 12500, totalGold: 33000 },
  ];
  const result = summarizeCharacterGold(raids);
  assert.equal(result.earned, 29500);
  assert.equal(result.total, 85000);
});

test("summarizeAccountGold: only counts characters with isGoldEarner=true", () => {
  // 1 gold-earner + 1 non-earner at 1730. Only the gold-earner contributes.
  const earner = makeChar("Earner", 1730, { isGoldEarner: true });
  const passive = makeChar("Passive", 1730, { isGoldEarner: false });
  const account = { accountName: "A", characters: [earner, passive], lastRefreshedAt: 0 };
  const result = summarizeAccountGold(account, getStatusRaidsForCharacter);
  assert.equal(result.total, 138000);
  assert.equal(result.earned, 0);
});

test("summarizeAccountGold: returns zero totals when no gold-earner is configured", () => {
  // Roster of all non-gold-earners → bot must surface 0/0 so the view
  // layer can suppress the rollup line entirely.
  const a = makeChar("Alt1", 1730, { isGoldEarner: false });
  const b = makeChar("Alt2", 1730, { isGoldEarner: false });
  const account = { accountName: "AltsOnly", characters: [a, b], lastRefreshedAt: 0 };
  const result = summarizeAccountGold(account, getStatusRaidsForCharacter);
  assert.equal(result.total, 0);
  assert.equal(result.earned, 0);
});

test("summarizeGlobalGold: composes summarizeAccountGold across multiple accounts", () => {
  const earnerA = makeChar("EarnerA", 1730, { isGoldEarner: true });
  const earnerB = makeChar("EarnerB", 1730, { isGoldEarner: true });
  const accounts = [
    { accountName: "A", characters: [earnerA], lastRefreshedAt: 0 },
    { accountName: "B", characters: [earnerB], lastRefreshedAt: 0 },
  ];
  const result = summarizeGlobalGold(accounts, getStatusRaidsForCharacter);
  assert.equal(result.total, 138000 * 2);
});

test("buildAccountPageEmbed: per-character field shows '💰 earned' (earned-only, no /total) for a gold-earner", () => {
  // Single gate done of two: earned is the gold actually banked (17000), and
  // the per-char line shows just that - not earned/total (that lives in the
  // rollup; the card's 2/2 raid lines already convey completion).
  const char = makeChar("Earner", 1730, { isGoldEarner: true });
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  const fakeRaid = {
    raidName: "Kazeros Hard",
    raidKey: "kazeros",
    modeKey: "hard",
    completedGateKeys: ["G1"],
    allGateKeys: ["G1", "G2"],
    isCompleted: false,
    earnedGold: 17000,
    totalGold: 52000,
  };
  const getRaidsFor = () => [fakeRaid];

  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 1, total: 1 }, characters: 1 },
    getRaidsFor
  );
  const json = embed.toJSON();
  const charField = json.fields.find((f) => /Earner/.test(f.name));
  assert.ok(charField, "char field should be present");
  assert.match(charField.value, /💰 17,000G/);
  assert.doesNotMatch(charField.value, /52,000G/); // earned-only; no "/ total"
});

test("buildAccountPageEmbed: can hide per-character gold lines for filtered raid view", () => {
  const char = makeChar("Filtered", 1730, { isGoldEarner: true });
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  const fakeRaid = {
    raidName: "Serca Hard",
    raidKey: "serca",
    modeKey: "hard",
    completedGateKeys: ["G1", "G2"],
    allGateKeys: ["G1", "G2"],
    isCompleted: true,
    earnedGold: 44000,
    totalGold: 44000,
  };
  const getRaidsFor = () => [fakeRaid];

  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 1, partial: 0, total: 1 }, characters: 1 },
    getRaidsFor,
    null,
    { showCharacterGold: false }
  );
  const charField = embed.toJSON().fields.find((f) => /Filtered/.test(f.name));

  assert.match(charField.value, /Serca Hard/);
  assert.doesNotMatch(charField.value, /💰/);
  assert.doesNotMatch(charField.value, /44,000G/);
});

test("buildAccountPageEmbed: per-character field omits the gold body line for non-earners (header 💰 absence is the signal)", () => {
  // Non-earner card: no 💰 anywhere in the body. Header marker is the
  // sole indicator (absence = not earning). Body line was removed in
  // round-32 because the duplicate signal was visual clutter.
  const char = makeChar("Passive", 1730, { isGoldEarner: false });
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  const fakeRaid = {
    raidName: "Kazeros Hard",
    completedGateKeys: [],
    allGateKeys: ["G1", "G2"],
    isCompleted: false,
    earnedGold: 0,
    totalGold: 52000,
  };
  const getRaidsFor = () => [fakeRaid];

  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 1 }, characters: 1 },
    getRaidsFor
  );
  const charField = embed.toJSON().fields.find((f) => /Passive/.test(f.name));
  // Header MUST NOT carry the 💰 suffix.
  assert.doesNotMatch(charField.name, /💰/);
  // Body MUST NOT carry any 💰 line.
  assert.doesNotMatch(charField.value, /💰/);
});

test("buildAccountPageEmbed: per-character header does NOT carry a 💰 suffix - gold body line is the sole indicator (round-32 rev)", () => {
  // Earlier round added a header marker `· 💰` after the iLvl, but the
  // body line `💰 earned / total G` already conveys the same info on
  // every gold-earner card so the header marker was visual duplication.
  // Removed per Traine's review (2026-05-05). Earner identity now lives
  // exclusively in the body line.
  const char = makeChar("Earner", 1730, { isGoldEarner: true });
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  const fakeRaid = {
    raidName: "Kazeros Hard",
    completedGateKeys: [],
    allGateKeys: ["G1", "G2"],
    isCompleted: false,
    earnedGold: 0,
    totalGold: 52000,
  };
  const getRaidsFor = () => [fakeRaid];

  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 1 }, characters: 1 },
    getRaidsFor
  );
  const charField = embed.toJSON().fields.find((f) => /Earner/.test(f.name));
  // Header is just `<class-icon> Name · iLvl`, no 💰 suffix.
  assert.doesNotMatch(charField.name, /💰/);
  // Body MUST still carry the 💰 line for an earner with eligible raids (even at
  // 0 earned); earned-only format now, no "/ total".
  assert.match(charField.value, /💰 0G/);
  assert.doesNotMatch(charField.value, /52,000G/);
});

test("buildAccountPageEmbed: real 1710 gold-earner with no clears still shows 0G", () => {
  const char = makeChar("Qiaoli", 1710, { isGoldEarner: true });
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };

  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 3 }, characters: 1 },
    getStatusRaidsForCharacter,
    null,
    { getProgressRaidsFor: getStatusProgressRaidsForCharacter }
  );
  const charField = embed.toJSON().fields.find((f) => /Qiaoli/.test(f.name));
  assert.ok(charField, "char field should be present");
  assert.match(charField.value, /Horizon/);
  assert.match(charField.value, /💰 0G/);
});

test("buildAccountPageEmbed: per-character bound gold renders inline after the earned gold", () => {
  const char = makeChar("Bound", 1730, { isGoldEarner: true });
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  // Horizon Level 2 cleared: earned 40,000 and all of it is character-bound.
  const fakeRaid = {
    raidName: "Horizon Level 2",
    raidKey: "horizon",
    modeKey: "hard",
    completedGateKeys: ["G1", "G2"],
    allGateKeys: ["G1", "G2"],
    isCompleted: true,
    earnedGold: 40000,
    totalGold: 40000,
    goldBound: true,
  };
  const getRaidsFor = () => [fakeRaid];
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 1, partial: 0, total: 1 }, characters: 1 },
    getRaidsFor
  );
  const charField = embed.toJSON().fields.find((f) => /Bound/.test(f.name));
  // earned-only gold + bound inline on the same line (short enough now /total is gone).
  assert.match(charField.value, /💰 40,000G · 🔒 \*\*40,000G\*\* khóa/);
});

test("buildAccountPageEmbed: shows '/raid-gold-earner' hint when account has at least one eligible non-earner char", () => {
  // Mixed account: 1 earner, 1 non-earner. The non-earner is a candidate
  // the user might want to flip - hint stays visible to advertise the
  // command.
  const earner = makeChar("Earner", 1730, { isGoldEarner: true });
  const passive = makeChar("Passive", 1730, { isGoldEarner: false });
  const account = { accountName: "Alpha", characters: [earner, passive], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 2 },
    getStatusRaidsForCharacter
  );
  const desc = embed.toJSON().description || "";
  assert.match(desc, /\/raid-gold-earner/);
});

test("buildAccountPageEmbed: omits '/raid-gold-earner' hint when every eligible char is already a gold-earner (no decision left)", () => {
  // Cap-reached-or-below state: every eligible char in the account is
  // marked. Nothing for the user to flip via the picker, so the hint is
  // noise. Covers both "5 chars all earner" (sub-cap) and "6 chars all
  // earner" (at cap).
  const a = makeChar("A", 1730, { isGoldEarner: true });
  const b = makeChar("B", 1730, { isGoldEarner: true });
  const account = { accountName: "Alpha", characters: [a, b], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 2 },
    getStatusRaidsForCharacter
  );
  const desc = embed.toJSON().description || "";
  assert.doesNotMatch(desc, /\/raid-gold-earner/);
});

test("buildAccountPageEmbed: omits '/raid-gold-earner' hint when non-earner chars are all sub-iLvl (cant earn anyway)", () => {
  // 1 earner at 1730 + 1 sub-1700 alt that's a non-earner. The alt has
  // zero eligible raids so it can't earn gold regardless of the flag -
  // doesn't count toward "decision pending". Hint should stay hidden.
  const earner = makeChar("Earner", 1730, { isGoldEarner: true });
  const baby = makeChar("Sub", 1500, { isGoldEarner: false });
  const account = { accountName: "Alpha", characters: [earner, baby], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 2 },
    getStatusRaidsForCharacter
  );
  const desc = embed.toJSON().description || "";
  assert.doesNotMatch(desc, /\/raid-gold-earner/);
});

test("buildAccountPageEmbed: omits '/raid-gold-earner' hint on empty roster (no chars to mark)", () => {
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 0 },
    NOOP_GET_RAIDS_FOR
  );
  const desc = embed.toJSON().description || "";
  assert.doesNotMatch(desc, /\/raid-gold-earner/);
});

test("buildAccountPageEmbed: per-character field omits the gold line when char has no eligible raids", () => {
  // Char too low iLvl for any raid → "🔒 Not eligible yet" notice;
  // tacking on a "💰 0G / 0G" line would just be noise.
  const char = makeChar("LowGear", 1500, { isGoldEarner: true });
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 0 }, characters: 1 },
    NOOP_GET_RAIDS_FOR
  );
  const charField = embed.toJSON().fields.find((f) => /LowGear/.test(f.name));
  assert.ok(charField, "low-gear char field should still render");
  assert.match(charField.value, /Chưa đủ điều kiện/);
  assert.doesNotMatch(charField.value, /💰/);
});

test("buildAccountPageEmbed: appends per-account 'Tuần này đã kiếm' rollup to description when account has gold-earners", () => {
  const char = makeChar("Earner", 1730, { isGoldEarner: true });
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 3 }, characters: 1 },
    getStatusRaidsForCharacter
  );
  const desc = embed.toJSON().description || "";
  // 1730 gold-earner has 4 eligible raids, but only 3 raid-gold slots.
  assert.match(desc, /💰 Tuần này đã kiếm:/);
  assert.match(desc, /138,000G/);
});

test("buildAccountPageEmbed: per-account rollup shows reduced-normal bound total", () => {
  const char = makeChar("NormalGold", 1710, { isGoldEarner: true });
  const account = { accountName: "Alpha", characters: [char], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 3 }, characters: 1 },
    getStatusRaidsForCharacter
  );
  const desc = embed.toJSON().description || "";
  assert.match(desc, /💰 Tuần này đã kiếm:/);
  assert.match(desc, /108,000G/);
  assert.match(desc, /🔒 \*\*0G \/ 54,000G\*\* khóa/);
});

test("buildAccountPageEmbed: omits per-account rollup when account has no gold-earners", () => {
  // All-passives account: rollup line would read '0G / 0G' which is
  // noise/misleading. Suppressed entirely.
  const char = makeChar("Alt", 1730, { isGoldEarner: false });
  const account = { accountName: "AltsOnly", characters: [char], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    1,
    { progress: { completed: 0, partial: 0, total: 3 }, characters: 1 },
    getStatusRaidsForCharacter
  );
  const desc = embed.toJSON().description || "";
  assert.doesNotMatch(desc, /Tuần này đã kiếm/);
});

test("buildAccountPageEmbed: cross-account 🌐 line tails the GRAND total gold across every roster when paginating", () => {
  // The per-account 'Tuần này đã kiếm' line below shows the current
  // page's account only; the 🌐 tail is the cross-account aggregate.
  // Both can show the same number when only one account has earners,
  // but with multiple accounts marked the tail diverges and acts as
  // the user's at-a-glance grand total.
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    3,
    {
      progress: { completed: 5, partial: 1, total: 8 },
      characters: 12,
      gold: { earned: 50000, total: 200000 },
    },
    NOOP_GET_RAIDS_FOR
  );
  const desc = embed.toJSON().description || "";
  assert.match(desc, /Tổng tất cả roster/);
  assert.match(desc, /5\/8/);
  // 🌐 line carries the gold tail in bold form for the grand total.
  assert.match(desc, /💰 \*\*50,000G \/ 200,000G\*\*/);
});

test("buildAccountPageEmbed: cross-account 🌐 line omits gold tail when grand total is 0 (all-non-earner roster)", () => {
  // Honesty rule: a roster where no one is a gold-earner shouldn't
  // surface a '💰 0G / 0G' grand total - it would just confuse users
  // into thinking their flags broke. Tail suppressed entirely.
  const account = { accountName: "Alpha", characters: [], lastRefreshedAt: 0 };
  const embed = buildAccountPageEmbed(
    account,
    0,
    3,
    {
      progress: { completed: 0, partial: 0, total: 0 },
      characters: 5,
      gold: { earned: 0, total: 0 },
    },
    NOOP_GET_RAIDS_FOR
  );
  const desc = embed.toJSON().description || "";
  assert.match(desc, /Tổng tất cả roster/);
  assert.doesNotMatch(desc, /All accounts.*💰/);
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

test("raid-status view toggle includes the received-gold screen", () => {
  const taskUi = createRaidStatusTaskUi({
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    getCharacterName,
    truncateText,
    getAccounts: () => [],
    getCurrentPage: () => 0,
    getCurrentView: () => "gold",
    getTaskCharFilter: () => undefined,
  });

  const options = taskUi.buildViewToggleRow(false).toJSON().components[0].options;
  assert.deepEqual(options.map((option) => option.value), ["raid", "task", "gold"]);
  assert.equal(options.find((option) => option.value === "gold").default, true);
});

test("raid-status gold view renders auto-bound status and setup dropdowns", () => {
  const char = {
    ...makeChar("Goldie", 1730, { isGoldEarner: true }),
    assignedRaids: {
      armoche: {},
      kazeros: {},
      serca: {},
      horizon: {
        modeKey: "hard",
        G1: { difficulty: "Hard", completedDate: 100 },
        G2: { difficulty: "Hard", completedDate: 100 },
      },
    },
  };
  const accounts = [{ accountName: "Alpha", characters: [char], lastRefreshedAt: 0 }];
  const goldUi = createRaidStatusGoldUi({
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    getCharacterName,
    truncateText,
    formatGold,
    getAccounts: () => accounts,
    getCurrentPage: () => 0,
    getGoldCharFilter: () => undefined,
    getRaidsFor: getStatusRaidsForCharacter,
    lang: "vi",
  });

  const embedJson = goldUi.buildGoldViewEmbed(accounts[0]).toJSON();
  assert.match(embedJson.title, /Gold nhận/);
  const goldField = embedJson.fields.find((field) => /Goldie/.test(field.name));
  assert.ok(goldField, "gold character field should render");
  assert.match(goldField.name, /Goldie\s*\u00B7\s*1730\s*\u00B7\s*3\/3/);
  assert.doesNotMatch(goldField.value, /\b3\/3\b/);
  assert.match(goldField.value, /Act 4 Hard - 42,000G/);
  assert.doesNotMatch(goldField.value, /0G\s*\/\s*\d/);
  assert.doesNotMatch(goldField.value, /42,000G\s*\/\s*42,000G/);
  assert.match(goldField.value, /Horizon Level 2 - locked/);
  assert.doesNotMatch(goldField.value, /gold bound/);
  assert.doesNotMatch(goldField.value, /auto bỏ qua vì/i);

  const rows = [
    goldUi.buildGoldCharFilterRow(false),
    goldUi.buildGoldToggleRow(false),
  ].filter(Boolean);
  assert.deepEqual(
    rows.map((row) => row.toJSON().components[0].custom_id),
    ["status-gold:char-filter", "status-gold:toggle"],
  );
  const toggleOptions = rows[1].toJSON().components[0].options;
  assert.equal(toggleOptions.length, 4);
  assert.ok(toggleOptions.some((option) => /auto bỏ qua locked/.test(option.label)));
});

test("raid-status gold view renders forced bound gold as a normal gold line with a lock before the amount", () => {
  const char = {
    ...makeChar("LockedGold", 1700, { isGoldEarner: true }),
    assignedRaids: {
      armoche: {},
      horizon: {
        goldOverride: "include",
        modeKey: "normal",
        G1: { difficulty: "Level 1", completedDate: 100 },
        G2: { difficulty: "Level 1", completedDate: 100 },
      },
    },
  };
  const accounts = [{ accountName: "Alpha", characters: [char], lastRefreshedAt: 0 }];
  const goldUi = createRaidStatusGoldUi({
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    getCharacterName,
    truncateText,
    formatGold,
    getAccounts: () => accounts,
    getCurrentPage: () => 0,
    getGoldCharFilter: () => undefined,
    getRaidsFor: getStatusRaidsForCharacter,
    lang: "vi",
  });

  const embedJson = goldUi.buildGoldViewEmbed(accounts[0]).toJSON();
  const goldField = embedJson.fields.find((field) => /LockedGold/.test(field.name));
  // Forced bound gold reads like any receiving line (💰 #slot label - amount),
  // with the lock moved to right before the amount to flag the bound gold.
  assert.match(goldField.value, new RegExp(`💰 #1 Horizon Level 1 - ${UI.icons.lock} 30,000G`));
  // No leading lock and no leftover "forced on"/"locked" tag on the line.
  assert.doesNotMatch(goldField.value, new RegExp(`${UI.icons.lock} #1 Horizon Level 1`));
  assert.doesNotMatch(goldField.value, /ép nhận|locked/);
});

test("raid-status gold view: an excluded UNBOUND raid stays neutral (no lock)", () => {
  // Act 4 (unbound) is force-excluded so Horizon (bound) can take its slot.
  // The lock must NOT appear on the unbound excluded raid - 🔒 is reserved for
  // bound gold so it stays in sync with the raid view (which only locks bound).
  const char = {
    ...makeChar("MixGold", 1730, { isGoldEarner: true }),
    assignedRaids: {
      armoche: { goldOverride: "exclude", modeKey: "hard", G1: { difficulty: "Hard", completedDate: 100 }, G2: { difficulty: "Hard", completedDate: 100 } },
      kazeros: { modeKey: "hard" },
      serca: { modeKey: "hard" },
      horizon: { goldOverride: "include", modeKey: "hard" },
    },
  };
  const accounts = [{ accountName: "Alpha", characters: [char], lastRefreshedAt: 0 }];
  const goldUi = createRaidStatusGoldUi({
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    getCharacterName,
    truncateText,
    formatGold,
    getAccounts: () => accounts,
    getCurrentPage: () => 0,
    getGoldCharFilter: () => undefined,
    getRaidsFor: getStatusRaidsForCharacter,
    lang: "vi",
  });

  const goldField = goldUi.buildGoldViewEmbed(accounts[0]).toJSON().fields.find((f) => /MixGold/.test(f.name));
  const act4Line = goldField.value.split("\n").find((l) => /Act 4 Hard/.test(l));
  assert.match(act4Line, new RegExp(`^${UI.icons.pending} Act 4 Hard`));
  assert.doesNotMatch(act4Line, new RegExp(UI.icons.lock));
  // Horizon (bound, forced) still carries the lock before its amount.
  const horizonLine = goldField.value.split("\n").find((l) => /Horizon/.test(l));
  assert.match(horizonLine, new RegExp(UI.icons.lock));
});
