"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");

const User = require("../bot/models/user");
const { getClassEmoji } = require("../bot/models/Class");
const {
  RAID_VISIBILITY_SHOW_ALL,
  applyGoldReceive,
  applyModeDecision,
  applyRaidVisibility,
  parseRaidVisibilityValues,
  saveBulkRaidVisibility,
} = require("../bot/handlers/raid-status/gold/gold-actions");
const {
  buildVisibilitySummaryNotice,
} = require("../bot/handlers/raid-status/gold/gold-summary");
const {
  computeRaidVisibilityOptions,
  raidVisibilityDefaults,
} = require("../bot/handlers/raid-status/gold/gold-ui/toggle-rows");
const { createRaidStatusGoldUi } = require("../bot/handlers/raid-status/gold/gold-ui");
const { createRaidStatusRenderPayload } = require("../bot/handlers/raid-status/view/render-payload");
const { createRaidStatusView } = require("../bot/handlers/raid-status/view/view");
const {
  buildRaidDropdownState,
  buildStatusRosterFilterEntries,
} = require("../bot/handlers/raid-status/raid-filter");
const {
  createRaidStatusSessionState,
  createRaidStatusComponentSession,
} = require("../bot/handlers/raid-status/state/session-state");
const {
  createStatusComponentRouteHandlers,
} = require("../bot/handlers/raid-status/components/component-handlers");
const {
  STATUS_COMPONENT_ACTION,
} = require("../bot/handlers/raid-status/components/component-routes");
const {
  createAllModePageRenderers,
} = require("../bot/handlers/raid-check/all-mode/all-mode-render");
const {
  filterAllModePageIndices,
} = require("../bot/handlers/raid-check/all-mode/all-mode-filters");
const {
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
  normalizeAssignedRaid,
  summarizeAccountGold,
  summarizeCharacterGold,
  summarizeGlobalGold,
  summarizeRaidProgress,
} = require("../bot/utils/raid/common/character");
const {
  projectSummary,
} = require("../bot/services/local-sync/core/preview-projection");
const {
  clearCharacterProgress,
  getTargetResetKey,
} = require("../bot/services/raid/schedulers/weekly-reset");
const {
  UI,
  formatGold,
  formatNextCooldownRemaining,
  getCharacterName,
  truncateText,
} = require("../bot/utils/raid/common/shared");

const directSave = async (attempt) => attempt();
const cleared = { difficulty: "Hard", completedDate: 1700000000000 };

function makeCharacter(name, itemLevel, assignedRaids = {}, extra = {}) {
  return { id: name, name, class: "Bard", itemLevel, assignedRaids, ...extra };
}

function makeRosterModel(characters) {
  const stats = { saves: 0 };
  const doc = new User({
    discordId: "owner-1",
    weeklyResetKey: getTargetResetKey(),
    accounts: [{ accountName: "MainRoster", characters }],
  });
  doc.save = async () => {
    stats.saves += 1;
    return doc;
  };
  return { stats, doc, model: { async findOne() { return doc; } } };
}

function makeRaidStatusView() {
  return createRaidStatusView({
    EmbedBuilder,
    UI,
    getCharacterName,
    truncateText,
    formatNextCooldownRemaining,
    summarizeRaidProgress,
    summarizeAccountGold,
    formatGold,
    formatRaidStatusLine,
    formatRosterRefreshCooldownRemaining: () => null,
    ROSTER_REFRESH_COOLDOWN_MS: 60_000,
    AUTO_MANAGE_SYNC_COOLDOWN_MS: 60_000,
    getAutoManageCooldownMs: () => 60_000,
    getRosterRefreshCooldownMs: () => 60_000,
  });
}

// ─── parser & persistence ──────────────────────────────────────────────────

test("parseRaidVisibilityValues accepts empty arrays to hide all raids and rejects unknown keys", () => {
  assert.deepEqual(parseRaidVisibilityValues([]), { kind: "set", raidKeys: [] });
  assert.deepEqual(parseRaidVisibilityValues(["kazeros", "kazeros", "serca"]), {
    kind: "set",
    raidKeys: ["kazeros", "serca"],
  });
  assert.deepEqual(parseRaidVisibilityValues(["unknown_raid"]), { kind: "invalid" });
  assert.deepEqual(parseRaidVisibilityValues(null), { kind: "invalid" });
});

test("saveBulkRaidVisibility persists assignedRaids[raidKey].hidden across strict:false Mongoose docs", async () => {
  const { stats, doc, model } = makeRosterModel([
    makeCharacter("HighChar", 1775),
    makeCharacter("LowChar", 1715),
  ]);

  // Keep kazeros + serca visible, hide the rest for HighChar and skip unavailable raids on LowChar.
  const hideRes = await saveBulkRaidVisibility({
    User: model,
    saveWithRetry: directSave,
    discordId: "owner-1",
    targetAccountName: "MainRoster",
    targetCharNames: ["HighChar", "LowChar"],
    visibility: parseRaidVisibilityValues(["kazeros", "serca"]),
  });
  assert.equal(hideRes.ok, true);
  assert.equal(stats.saves, 1);

  const plainChars = doc.toObject().accounts[0].characters;
  assert.equal(plainChars[0].assignedRaids.armoche?.hidden, true);
  assert.equal(plainChars[0].assignedRaids.belgardin?.hidden, true);
  assert.equal(plainChars[0].assignedRaids.kazeros?.hidden, undefined);
  assert.equal(plainChars[0].assignedRaids.serca?.hidden, undefined);
  assert.equal(plainChars[1].assignedRaids.armoche?.hidden, true);

  const notice = buildVisibilitySummaryNotice({
    result: hideRes,
    visibility: { kind: "set", raidKeys: ["kazeros", "serca"] },
    lang: "vi",
    getClassEmoji,
  });
  assert.equal(notice.kind, "done");
  assert.match(notice.description, /Act 4/);

  // Show-all clears every hidden flag cleanly.
  const resetRes = await saveBulkRaidVisibility({
    User: model,
    saveWithRetry: directSave,
    discordId: "owner-1",
    targetAccountName: "MainRoster",
    targetCharNames: ["HighChar", "LowChar"],
    visibility: { kind: RAID_VISIBILITY_SHOW_ALL },
  });
  assert.equal(resetRes.ok, true);
  assert.equal(stats.saves, 2);
  const resetChars = doc.toObject().accounts[0].characters;
  assert.equal(resetChars[0].assignedRaids?.armoche?.hidden, undefined);
  assert.equal(resetChars[1].assignedRaids?.armoche?.hidden, undefined);
});

test("hidden flag survives normalizeAssignedRaid, mode switches, gold overrides, weekly reset, and local sync", () => {
  const char = makeCharacter("MainChar", 1775, {
    armoche: { modeKey: "hard", hidden: true, goldOverride: "include", G1: cleared },
  });

  const normalized = normalizeAssignedRaid(char.assignedRaids.armoche, "Hard", "armoche");
  assert.equal(normalized.hidden, true);

  applyModeDecision(char, "armoche", { modeKey: "normal" });
  assert.equal(char.assignedRaids.armoche.hidden, true);

  applyGoldReceive(char, { kind: "auto" });
  assert.equal(char.assignedRaids.armoche.hidden, true);

  clearCharacterProgress(char);
  assert.equal(char.assignedRaids.armoche.goldOverride, undefined);
  assert.equal(char.assignedRaids.armoche.hidden, true);

  const preview = projectSummary(
    [{ accountName: "MainRoster", characters: [char] }],
    [],
  );
  assert.equal(preview.accountsAfterSync[0].characters[0].assignedRaids.armoche.hidden, true);
});

// ─── gold independence + Raid tab + /raid-check ────────────────────────────

test("hiding a raid leaves gold calculation identical while removing it from /raid-status Raid tab and /raid-check", () => {
  const visibleChar = makeCharacter("MainChar", 1720, {
    armoche: { modeKey: "hard", goldOverride: "include", G1: cleared },
    kazeros: { modeKey: "normal" },
    serca: { modeKey: "normal" },
  });
  const hiddenAct4Char = makeCharacter("MainChar", 1720, {
    armoche: { modeKey: "hard", hidden: true, goldOverride: "include", G1: cleared },
    kazeros: { modeKey: "normal" },
    serca: { modeKey: "normal" },
  });

  const beforeRaids = getStatusRaidsForCharacter(visibleChar);
  const afterRaids = getStatusRaidsForCharacter(hiddenAct4Char);
  assert.equal(afterRaids.find((r) => r.raidKey === "armoche").hidden, true);
  assert.deepEqual(summarizeCharacterGold(afterRaids), summarizeCharacterGold(beforeRaids));

  const accountVisible = { accountName: "Main", characters: [visibleChar] };
  const accountHidden = { accountName: "Main", characters: [hiddenAct4Char] };
  assert.deepEqual(
    summarizeAccountGold(accountHidden, getStatusRaidsForCharacter),
    summarizeAccountGold(accountVisible, getStatusRaidsForCharacter),
  );
  assert.deepEqual(
    summarizeGlobalGold([accountHidden], getStatusRaidsForCharacter),
    summarizeGlobalGold([accountVisible], getStatusRaidsForCharacter),
  );

  const view = makeRaidStatusView();
  const payload = createRaidStatusRenderPayload({
    discordId: "owner-1",
    getAccounts: () => [accountHidden],
    getCurrentPage: () => 0,
    getCurrentLocalPage: () => 0,
    getVisibleRosterCount: () => 1,
    getCurrentView: () => "raid",
    getFilterRaidId: () => null,
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: getStatusRaidsForCharacter,
    totalCharacters: 1,
    summarizeRaidProgress,
    summarizeGlobalGold,
    buildAccountPageEmbed: view.buildAccountPageEmbed,
    buildGoldViewEmbed: () => new EmbedBuilder(),
    buildTaskViewEmbed: () => new EmbedBuilder(),
    lang: "vi",
  });
  const embedJson = payload.buildCurrentEmbed().toJSON();
  const charField = embedJson.fields[0];
  assert.doesNotMatch(charField.value, /Act 4/);
  assert.match(charField.value, /Kazeros/);
  assert.match(charField.value, /Serca/);

  const goldBefore = summarizeAccountGold(accountVisible, getStatusRaidsForCharacter);
  assert.match(charField.value, new RegExp(formatGold(goldBefore.earnedUnbound).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Unfiltered raid dropdown & roster pending counts omit hidden Act 4.
  const dropdown = buildRaidDropdownState([accountHidden], getStatusRaidsForCharacter);
  assert.equal(dropdown.raidDropdownEntries.some((entry) => entry.raidKey === "armoche"), false);
  const rosterState = buildStatusRosterFilterEntries({
    accounts: [accountHidden],
    raidFilter: null,
    getRaidsFor: getStatusRaidsForCharacter,
  });
  assert.equal(rosterState[0].total, 2);

  // /raid-check hides Act 4 from both all-mode render and roster filter state.
  const authorMeta = new Map([["owner-1", { displayName: "Mgr", avatarURL: null }]]);
  const checkRenderers = createAllModePageRenderers({
    authorMeta,
    buildAccountPageEmbed: view.buildAccountPageEmbed,
    buildStatusFooterText: view.buildStatusFooterText,
    getState: () => ({
      filterRaidId: null,
      filterStatus: "all",
      currentLocalPage: 0,
      filteredIndices: [0],
    }),
    getStatusRaidsForCharacter,
    lang: "vi",
    pagesData: [{ userDoc: { discordId: "owner-1", accounts: [accountHidden] }, account: accountHidden }],
    summarizeRaidProgress,
    truncateText,
  });
  const checkEmbed = checkRenderers.buildRaidPage(0).toJSON();
  assert.doesNotMatch(checkEmbed.fields[0].value, /Act 4/);
  assert.match(checkEmbed.fields[0].value, /Kazeros/);
  const filteredPages = filterAllModePageIndices({
    pagesData: [{ userDoc: { discordId: "owner-1", accounts: [accountHidden] }, account: accountHidden }],
    filterRaidId: "armoche:hard",
    getStatusRaidsForCharacter,
  });
  assert.deepEqual(filteredPages.filteredIndices, []);
});

test("hiding every raid on an eligible character renders allRaidsHidden instead of notEligible while keeping gold", () => {
  const allHiddenChar = makeCharacter("AllHidden", 1720, {
    armoche: { modeKey: "hard", hidden: true, G1: cleared, G2: cleared },
    kazeros: { modeKey: "normal", hidden: true },
    serca: { modeKey: "normal", hidden: true },
    horizon: { modeKey: "normal", hidden: true },
  });
  const account = { accountName: "Main", characters: [allHiddenChar] };
  const view = makeRaidStatusView();
  const payload = createRaidStatusRenderPayload({
    discordId: "owner-1",
    getAccounts: () => [account],
    getCurrentPage: () => 0,
    getCurrentLocalPage: () => 0,
    getVisibleRosterCount: () => 1,
    getCurrentView: () => "raid",
    getFilterRaidId: () => null,
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: getStatusRaidsForCharacter,
    totalCharacters: 1,
    summarizeRaidProgress,
    summarizeGlobalGold,
    buildAccountPageEmbed: view.buildAccountPageEmbed,
    buildGoldViewEmbed: () => new EmbedBuilder(),
    buildTaskViewEmbed: () => new EmbedBuilder(),
    lang: "vi",
  });
  const embedJson = payload.buildCurrentEmbed().toJSON();
  const charField = embedJson.fields[0];
  assert.match(charField.value, /Đã ẩn tất cả raid/);
  assert.doesNotMatch(charField.value, /Chưa đủ điều kiện/);
  assert.match(charField.value, /💰/);
});

// ─── sub-view UI + non-gold-earners + component handlers ───────────────────

test("visibility sub-view includes non-gold-earners and marks hidden raids clearly", () => {
  const nonEarner = makeCharacter("SeventhChar", 1715, {
    armoche: { modeKey: "normal", hidden: true },
    kazeros: { modeKey: "normal" },
    serca: { modeKey: "normal" },
  }, { isGoldEarner: false });

  const ui = createRaidStatusGoldUi({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    UI,
    getCharacterName,
    truncateText,
    formatGold,
    getAccounts: () => [{ accountName: "Main", characters: [nonEarner] }],
    getCurrentPage: () => 0,
    getGoldCharSelection: () => [],
    getVisibilityCharSelection: () => ["SeventhChar"],
    getGoldSubView: () => "visibility",
    getRaidsFor: getStatusRaidsForCharacter,
    lang: "vi",
  });

  const charsRow = ui.buildVisibilityCharsRow(false).toJSON().components[0];
  assert.deepEqual(charsRow.options.map((o) => o.value), ["SeventhChar"]);

  const raidsRow = ui.buildVisibilityRaidsRow(false).toJSON().components[0];
  assert.equal(raidsRow.min_values, 0);
  const armocheOpt = raidsRow.options.find((o) => o.value === "armoche");
  const kazerosOpt = raidsRow.options.find((o) => o.value === "kazeros");
  assert.equal(armocheOpt.default, false);
  assert.equal(kazerosOpt.default, true);
  assert.deepEqual(
    raidVisibilityDefaults([{ raids: getStatusRaidsForCharacter(nonEarner) }]),
    ["kazeros", "serca"],
  );
  assert.equal(computeRaidVisibilityOptions([{ raids: getStatusRaidsForCharacter(nonEarner) }]).length, 3);

  const embedJson = ui.buildGoldViewEmbed({ accountName: "Main", characters: [nonEarner] }).toJSON();
  assert.match(embedJson.title, /Hiển thị raid/);
  assert.match(embedJson.fields[0].value, /🙈 ~~Act 4/);
  assert.match(embedJson.fields[0].value, /👁️ Kazeros/);
});

test("gold sub-view and visibility component handlers toggle view, save visibility, and respect view-only shares", async () => {
  const { doc, model } = makeRosterModel([makeCharacter("MainChar", 1720)]);
  const state = await createRaidStatusSessionState({
    User: model,
    discordId: "owner-1",
    userDoc: doc.toObject(),
    incomingSharedAccounts: [],
    buildMergedAccounts: async (_, accounts) => accounts,
    getStatusRaidsForCharacter,
    buildRaidDropdownState,
    buildStatusRosterFilterEntries,
    initialView: "gold",
  });
  const session = createRaidStatusComponentSession({
    state,
    getStatusUserMeta: () => ({}),
    setStatusUserMeta: () => {},
    syncControls: { setCachedLocalSyncResumeUrl: () => {} },
  });

  const ui = createRaidStatusGoldUi({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    UI,
    getCharacterName,
    truncateText,
    formatGold,
    getAccounts: () => state.accounts,
    getCurrentPage: () => state.currentPage,
    getGoldCharSelection: (p) => state.getGoldCharSelection(p),
    getVisibilityCharSelection: (p) => state.getVisibilityCharSelection(p),
    getGoldSubView: () => state.goldSubView,
    getRaidsFor: state.baseGetRaidsFor,
    lang: "vi",
  });

  const followUps = [];
  const handlers = createStatusComponentRouteHandlers({
    session,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    User: model,
    saveWithRetry: directSave,
    interaction: {},
    discordId: "owner-1",
    lang: "vi",
    buildStatusUserMeta: () => ({}),
    reloadViewerAccounts: (nextDoc) => state.reloadViewerAccounts(nextDoc),
    buildEmbedAndCanvas: async () => ({ embeds: [], files: [], attachments: [] }),
    buildComponents: () => [],
    redrawMessage: async () => {},
    runManualStatusSync: async () => {},
    runManualRosterRefresh: async () => {},
    formatNextCooldownRemaining,
    getAutoManageCooldownMs: () => 60_000,
    isReplyPrivate: () => true,
    getGoldSelection: ui.selectedGoldEntries,
    getVisibilitySelection: ui.selectedVisibilityEntries,
  });

  // Switch gold -> visibility sub-view, then submit an empty selection (hides all raids).
  const subRes = await handlers[STATUS_COMPONENT_ACTION.goldSubView]({});
  assert.deepEqual(subRes, { redraw: true });
  assert.equal(state.goldSubView, "visibility");

  const writeRes = await handlers[STATUS_COMPONENT_ACTION.goldVisibility]({
    values: [],
    followUp: async (payload) => followUps.push(payload),
  });
  assert.deepEqual(writeRes, { redraw: true });
  assert.equal(followUps.length, 1);
  assert.equal(doc.toObject().accounts[0].characters[0].assignedRaids.armoche.hidden, true);
  assert.equal(doc.toObject().accounts[0].characters[0].assignedRaids.kazeros.hidden, true);

  // Switching away from gold tab resets sub-view back to gold.
  state.currentView = "raid";
  assert.equal(state.goldSubView, "gold");

  // View-only share rejects visibility writes without saving.
  const viewOnlyFollowUps = [];
  const sharedHandlers = createStatusComponentRouteHandlers({
    session: {
      accounts: [{
        accountName: "SharedRoster",
        characters: [makeCharacter("SharedChar", 1720)],
        _sharedFrom: { ownerDiscordId: "owner-1", ownerLabel: "Owner", accessLevel: "view" },
      }],
      currentPage: 0,
      goldSubView: "visibility",
    },
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    User: model,
    saveWithRetry: directSave,
    interaction: {},
    discordId: "viewer-2",
    lang: "vi",
    buildStatusUserMeta: () => ({}),
    reloadViewerAccounts: async () => {},
    buildEmbedAndCanvas: async () => ({ embeds: [], files: [], attachments: [] }),
    buildComponents: () => [],
    redrawMessage: async () => {},
    runManualStatusSync: async () => {},
    runManualRosterRefresh: async () => {},
    formatNextCooldownRemaining,
    getAutoManageCooldownMs: () => 60_000,
    isReplyPrivate: () => true,
    canEditAccountFn: async () => false,
    getAccessibleAccountsFn: async () => [{ ownerDiscordId: "owner-1", accessLevel: "view", isOwn: false }],
    getVisibilitySelection: () => [{ name: "SharedChar", itemLevel: 1720, raids: [] }],
  });
  const refused = await sharedHandlers[STATUS_COMPONENT_ACTION.goldVisibility]({
    values: ["kazeros"],
    followUp: async (payload) => viewOnlyFollowUps.push(payload),
  });
  assert.deepEqual(refused, { redraw: false });
  assert.equal(viewOnlyFollowUps.length, 1);
});
