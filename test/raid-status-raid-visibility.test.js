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
  RAID_VISIBILITY_HIDE_ALL,
  RAID_VISIBILITY_SHOW_ALL,
  applyGoldReceive,
  applyModeDecision,
  parseRaidVisibilityValues,
  saveBulkRaidVisibility,
} = require("../bot/handlers/raid-status/gold/gold-actions");
const {
  buildVisibilitySummaryNotice,
} = require("../bot/handlers/raid-status/gold/gold-summary");
const {
  computeRaidVisibilityOptions,
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
  attachRaidStatusComponentCollector,
} = require("../bot/handlers/raid-status/components/component-collector");
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

test("parseRaidVisibilityValues accepts empty arrays and hide_all to hide all raids, and rejects unknown keys", () => {
  assert.deepEqual(parseRaidVisibilityValues([]), { kind: "set", raidKeys: [] });
  assert.deepEqual(parseRaidVisibilityValues([RAID_VISIBILITY_HIDE_ALL]), {
    kind: RAID_VISIBILITY_HIDE_ALL,
  });
  assert.deepEqual(parseRaidVisibilityValues(["armoche", RAID_VISIBILITY_HIDE_ALL]), {
    kind: RAID_VISIBILITY_HIDE_ALL,
  });
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
  assert.match(charField.value, /💤 _Đã ẩn hết raid_/);
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

  let currentSubView = "visibility";
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
    getGoldSubView: () => currentSubView,
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
  // The menu mirrors the card: a ticked raid shows 🔹, an unticked one 💤.
  assert.equal(armocheOpt.emoji.name, "💤");
  assert.equal(kazerosOpt.emoji.name, "🔹");
  assert.equal(ui.buildVisibilityResetButton(false).toJSON().emoji.name, "🔄");
  assert.equal(ui.buildGoldSubViewButton(false).toJSON().emoji.name, "💰");
  currentSubView = "gold";
  assert.equal(ui.buildGoldSubViewButton(false).toJSON().emoji.name, "⚙️");
  currentSubView = "visibility";
  const nonEarnerOptions = computeRaidVisibilityOptions([{ raids: getStatusRaidsForCharacter(nonEarner) }]);
  assert.deepEqual(
    nonEarnerOptions.filter((o) => o.default).map((o) => o.value),
    ["kazeros", "serca"],
  );
  assert.equal(nonEarnerOptions.length, 3);

  const embedJson = ui.buildGoldViewEmbed({ accountName: "Main", characters: [nonEarner] }).toJSON();
  assert.match(embedJson.title, /^⚙️ Hiển thị raid/);
  // 🔹 and 💤 are both emoji, so the two states line up at one size; ➖
  // already means "will be removed" on the roster edit card.
  // 💤 and the strikethrough already say hidden, so no "đã ẩn" tail.
  assert.match(embedJson.fields[0].value, /^💤 ~~Act 4[^~]*~~$/m);
  assert.doesNotMatch(embedJson.fields[0].value, /đã ẩn/);
  assert.match(embedJson.fields[0].value, /🔹 Kazeros/);
  assert.doesNotMatch(embedJson.fields[0].value, /➖|•/);
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

test("multi-character visibility options pre-tick raids shown for every eligible character even when iLvl or hidden sets differ", () => {
  const high = makeCharacter("Main1755", 1755, {});
  const low = makeCharacter("Alt1700", 1700, {});
  const buildMenu = (characters, selection) => {
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
      getAccounts: () => [{ accountName: "Main", characters }],
      getCurrentPage: () => 0,
      getGoldCharSelection: () => selection,
      getVisibilityCharSelection: () => selection,
      getGoldSubView: () => "visibility",
      getRaidsFor: getStatusRaidsForCharacter,
      lang: "vi",
    });
    return ui.buildVisibilityRaidsRow(false).toJSON().components[0].options;
  };

  // Different item levels, nothing hidden: every raid stays ticked and marked 🔹,
  // while the trailing hide_all helper option stays unticked and marked 💤.
  const diffIlvlOptions = buildMenu([high, low], ["Main1755", "Alt1700"]);
  const hideAllOpt = diffIlvlOptions[diffIlvlOptions.length - 1];
  assert.equal(hideAllOpt.value, RAID_VISIBILITY_HIDE_ALL);
  assert.equal(hideAllOpt.default, false);
  assert.equal(hideAllOpt.emoji.name, "💤");
  for (const opt of diffIlvlOptions.slice(0, -1)) {
    assert.equal(opt.default, true, `${opt.value} should stay pre-ticked when nothing is hidden`);
    assert.equal(opt.emoji.name, "🔹", `${opt.value} should keep 🔹 icon`);
  }
  const kazerosDiff = diffIlvlOptions.find((o) => o.value === "kazeros");
  assert.match(kazerosDiff.description, /1\/1 con đang hiện/);
  assert.match(kazerosDiff.description, /1\/2 con có raid này/);

  // Same item level, only Act 4 hidden on CharA: Act 4 unticked (💤), rest stay ticked (🔹).
  const charA = makeCharacter("CharA", 1755, { armoche: { hidden: true } });
  const charB = makeCharacter("CharB", 1755, {});
  const diffHiddenOptions = buildMenu([charA, charB], ["CharA", "CharB"]);
  const armocheOpt = diffHiddenOptions.find((o) => o.value === "armoche");
  assert.equal(armocheOpt.default, false);
  assert.equal(armocheOpt.emoji.name, "💤");
  for (const raidKey of ["kazeros", "serca", "horizon", "belgardin"]) {
    const opt = diffHiddenOptions.find((o) => o.value === raidKey);
    assert.equal(opt.default, true, `${raidKey} should remain pre-ticked`);
    assert.equal(opt.emoji.name, "🔹", `${raidKey} should keep 🔹 icon`);
  }
});

test("unfiltered /raid-check preserves gold from hidden gold-earning raids", () => {
  const charVisible = makeCharacter("Main1755", 1755, {
    armoche: { modeKey: "hard", goldOverride: "include", G1: cleared, G2: cleared },
    kazeros: { modeKey: "hard" },
    serca: { modeKey: "nightmare" },
  });
  const charHidden = makeCharacter("Main1755", 1755, {
    armoche: { modeKey: "hard", hidden: true, goldOverride: "include", G1: cleared, G2: cleared },
    kazeros: { modeKey: "hard" },
    serca: { modeKey: "nightmare" },
  });
  const renderCheck = (character) => {
    const account = { accountName: "Main", characters: [character] };
    const userDoc = { discordId: "owner-1", accounts: [account] };
    const view = makeRaidStatusView();
    const renderers = createAllModePageRenderers({
      authorMeta: new Map([["owner-1", { displayName: "Mgr", avatarURL: null }]]),
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
      pagesData: [{ userDoc, account }],
      summarizeRaidProgress,
      truncateText,
    });
    return renderers.buildRaidPage(0).toJSON();
  };

  const expected = renderCheck(charVisible);
  const actual = renderCheck(charHidden);
  assert.equal(actual.description, expected.description);
  const expectedGoldLine = expected.fields[0].value.split("\n").find((l) => l.startsWith("💰"));
  const actualGoldLine = actual.fields[0].value.split("\n").find((l) => l.startsWith("💰"));
  assert.equal(actualGoldLine, expectedGoldLine);
  assert.doesNotMatch(actual.fields[0].value, /Act 4/);
});

test("raid-status collector refreshes stale state before visibility navigation actions", async () => {
  for (const [customId, action] of [
    ["status-gold:subview", STATUS_COMPONENT_ACTION.goldSubView],
    ["status-gold:visibility-chars", STATUS_COMPONENT_ACTION.goldVisibilityChars],
  ]) {
    const listeners = new Map();
    const calls = [];
    const collector = {
      on(event, handler) {
        listeners.set(event, handler);
        return this;
      },
    };
    attachRaidStatusComponentCollector({
      EmbedBuilder: { from: (embed) => embed },
      User: {},
      interaction: {
        user: { id: "owner-1" },
        editReply: async () => {
          calls.push("edit");
          return {};
        },
      },
      message: { createMessageComponentCollector: () => collector },
      lang: "vi",
      sessionMs: 60_000,
      taskAutoRefreshGraceMs: 1_000,
      getAccounts: () => [],
      getCurrentPage: () => 0,
      getCurrentView: () => "gold",
      buildCurrentEmbeds: () => [{}],
      buildEmbedAndCanvas: async () => {
        calls.push("render");
        return { embeds: [{}] };
      },
      buildComponents: () => [],
      componentRouteHandlers: {
        [action]: async () => {
          calls.push("handler");
          return { redraw: true };
        },
      },
      refreshStateIfStale: async () => {
        calls.push("refresh");
      },
    });

    await listeners.get("collect")({
      customId,
      user: { id: "owner-1" },
      deferUpdate: async () => {
        calls.push("defer");
      },
    });
    assert.deepEqual(calls, ["defer", "refresh", "handler", "render", "edit"], `${customId} should refresh`);
  }
});

test("Local Sync preview projection excludes hidden raids from completion totals while keeping gold", () => {
  const hiddenWithClear = makeCharacter("Main1755", 1755, {
    armoche: { hidden: true, modeKey: "hard", goldOverride: "include" },
    kazeros: { hidden: true, modeKey: "hard" },
  });
  const baseAccount = { accountName: "Main", characters: [hiddenWithClear] };
  const nowMs = Date.now();
  const weekStartMs = nowMs - 60_000;
  const deltas = [
    {
      charName: "Main1755",
      raidKey: "armoche",
      modeKey: "hard",
      gate: "G1",
      gateIndex: 0,
      lastClearMs: nowMs,
      gold: 17000,
    },
    {
      charName: "Main1755",
      raidKey: "armoche",
      modeKey: "hard",
      gate: "G2",
      gateIndex: 1,
      lastClearMs: nowMs,
      gold: 25000,
    },
  ];
  const summary = projectSummary([baseAccount], deltas, { currentWeekStartMs: weekStartMs });
  // 5 total eligible raids - 2 hidden = 3 visible in completion totals.
  assert.equal(summary.completion.totalRaids, 3);
  assert.equal(summary.completion.cleared, 0);
  assert.equal(summary.completion.projected, 0);
  assert.equal(summary.completion.percent, 0);
  assert.equal(summary.completion.projectedPercent, 0);
  // Gold and change details from incoming hidden raid clear remain projected.
  assert.equal(summary.changes.gates, 2);
  assert.equal(summary.goldDelta.total > 0, true);
});

test("visibility save errors and share refusals report raid visibility instead of gold settings", async () => {
  const { model } = makeRosterModel([makeCharacter("SharedChar", 1720)]);
  const buildHandlers = ({ saveFn = directSave, sharedFrom = null, canEdit = true } = {}) => {
    const account = {
      accountName: "Main",
      characters: [makeCharacter("SharedChar", 1720)],
      ...(sharedFrom ? { _sharedFrom: sharedFrom } : {}),
    };
    return createStatusComponentRouteHandlers({
      session: { accounts: [account], currentPage: 0, goldSubView: "visibility" },
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      User: model,
      saveWithRetry: saveFn,
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
      canEditAccountFn: async () => canEdit,
      getAccessibleAccountsFn: async () => [{ ownerDiscordId: "owner-1", accessLevel: "view", isOwn: false }],
      getVisibilitySelection: () => [{ name: "SharedChar", itemLevel: 1720, raids: [] }],
    });
  };

  // Share refusal (view-only)
  const shareFollowUps = [];
  const viewOnlyHandlers = buildHandlers({
    sharedFrom: { ownerDiscordId: "owner-1", ownerLabel: "Owner", accessLevel: "view" },
    canEdit: false,
  });
  await viewOnlyHandlers[STATUS_COMPONENT_ACTION.goldVisibility]({
    values: ["kazeros"],
    followUp: async (payload) => shareFollowUps.push(payload),
  });
  const shareDesc = shareFollowUps[0].embeds[0].toJSON().description;
  assert.match(shareDesc, /hiển thị raid/);
  assert.doesNotMatch(shareDesc, /cài đặt gold/);

  // Save failure
  const failFollowUps = [];
  const failingHandlers = buildHandlers({
    saveFn: async () => {
      throw new Error("boom");
    },
  });
  await failingHandlers[STATUS_COMPONENT_ACTION.goldVisibility]({
    values: ["kazeros"],
    followUp: async (payload) => failFollowUps.push(payload),
  });
  const failDesc = failFollowUps[0].embeds[0].toJSON().description;
  assert.match(failDesc, /hiển thị raid/);
  assert.doesNotMatch(failDesc, /cài đặt gold/);
});

test("single-raid 1700-1709 Solo characters keep max_values >= 2 via hide_all and hide clean via menu or Hide all button", async () => {
  const soloOnly = makeCharacter("Nachtsieger", 1709, { armoche: { modeKey: "solo" } });
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
    getAccounts: () => [{ accountName: "Guavajuice", characters: [soloOnly] }],
    getCurrentPage: () => 0,
    getGoldCharSelection: () => ["Nachtsieger"],
    getVisibilityCharSelection: () => ["Nachtsieger"],
    getGoldSubView: () => "visibility",
    getRaidsFor: getStatusRaidsForCharacter,
    lang: "vi",
  });

  const raidsSelect = ui.buildVisibilityRaidsRow(false).toJSON().components[0];
  assert.deepEqual(raidsSelect.options.map((opt) => opt.value), ["armoche", RAID_VISIBILITY_HIDE_ALL]);
  assert.equal(raidsSelect.min_values, 0);
  assert.equal(raidsSelect.max_values, 2, "single-raid char must not collapse to a pre-ticked max_values=1 select");
  assert.equal(ui.buildVisibilityHideAllButton(false).toJSON().custom_id, "status-gold:visibility-hide-all");

  // Both picking `hide_all` alongside the pre-ticked raid AND clicking the Hide all button hide armoche:solo.
  for (const trigger of [
    (handlers, followUps) => handlers[STATUS_COMPONENT_ACTION.goldVisibility]({
      values: ["armoche", RAID_VISIBILITY_HIDE_ALL],
      followUp: async (payload) => followUps.push(payload),
    }),
    (handlers, followUps) => handlers[STATUS_COMPONENT_ACTION.goldVisibilityHideAll]({
      followUp: async (payload) => followUps.push(payload),
    }),
  ]) {
    const { doc, model } = makeRosterModel([makeCharacter("Nachtsieger", 1709, { armoche: { modeKey: "solo" } })]);
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
    session.goldSubView = "visibility";
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
      getGoldSelection: () => [],
      getVisibilitySelection: () => [{ name: "Nachtsieger", itemLevel: 1709, raids: [] }],
    });

    const res = await trigger(handlers, followUps);
    assert.deepEqual(res, { redraw: true });
    assert.equal(doc.toObject().accounts[0].characters[0].assignedRaids.armoche.hidden, true);
    assert.equal(state.raidDropdownEntries.some((entry) => entry.key === "armoche:solo"), false);
    assert.equal(state.totalSoloPending, 0);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0].embeds[0].toJSON().title, /ẩn hết raid/);
  }
});

test("view-only share refuses Hide all visibility button without saving", async () => {
  const { stats, model } = makeRosterModel([makeCharacter("SharedChar", 1709, { armoche: { modeKey: "solo" } })]);
  const followUps = [];
  const handlers = createStatusComponentRouteHandlers({
    session: {
      accounts: [{
        accountName: "SharedRoster",
        characters: [makeCharacter("SharedChar", 1709, { armoche: { modeKey: "solo" } })],
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
    getVisibilitySelection: () => [{ name: "SharedChar", itemLevel: 1709, raids: [] }],
  });

  const res = await handlers[STATUS_COMPONENT_ACTION.goldVisibilityHideAll]({
    followUp: async (payload) => followUps.push(payload),
  });
  assert.deepEqual(res, { redraw: false });
  assert.equal(stats.saves, 0);
  assert.equal(followUps.length, 1);
  assert.match(followUps[0].embeds[0].toJSON().description, /quyền xem/);
});
