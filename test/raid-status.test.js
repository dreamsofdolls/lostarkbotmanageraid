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
  formatGold,
} = require("../bot/utils/raid/shared");
const {
  summarizeRaidProgress,
  summarizeAccountGold,
  summarizeGlobalGold,
  summarizeCharacterGold,
  computeRaidGold,
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

test("getStatusRaidsForCharacter: decorates each raid entry with earnedGold + totalGold", () => {
  // 1730 char defaults to Hard across all 3 raids per
  // getBestEligibleModeKey logic. Sum at this iLvl: Act 4 Hard 42000 +
  // Kazeros Hard 52000 + Serca Hard 44000 = 138000G total.
  const char = makeChar("Maxlevel", 1730);
  const raids = getStatusRaidsForCharacter(char);
  assert.equal(raids.length, 3);
  for (const raid of raids) {
    assert.ok(typeof raid.earnedGold === "number", `raid ${raid.raidName} missing earnedGold`);
    assert.ok(typeof raid.totalGold === "number", `raid ${raid.raidName} missing totalGold`);
  }
  const sum = raids.reduce((acc, r) => acc + r.totalGold, 0);
  assert.equal(sum, 138000);
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

test("buildAccountPageEmbed: per-character field appends '💰 X / Y' for gold-earner with eligible raids", () => {
  // Synthetic raid entry with a single gate done out of two (so total
  // surfaces but earned is non-zero).
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
  assert.match(charField.value, /💰 17,000G \/ 52,000G/);
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
  // Body MUST still carry the 💰 line for an earner with eligible raids.
  assert.match(charField.value, /💰 0G \/ 52,000G/);
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
  assert.match(charField.value, /Not eligible/);
  assert.doesNotMatch(charField.value, /💰/);
});

test("buildAccountPageEmbed: appends per-account 'Earned this week' rollup to description when account has gold-earners", () => {
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
  // 1730 gold-earner = 138000G total potential, 0 earned.
  assert.match(desc, /💰 Earned this week:/);
  assert.match(desc, /138,000G/);
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
  assert.doesNotMatch(desc, /Earned this week/);
});

test("buildAccountPageEmbed: cross-account 🌐 line tails the GRAND total gold across every roster when paginating", () => {
  // The per-account 'Earned this week' line below shows the current
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
  assert.match(desc, /All accounts/);
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
  assert.match(desc, /All accounts/);
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
