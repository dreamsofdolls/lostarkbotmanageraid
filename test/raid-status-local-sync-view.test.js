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

const {
  STATUS_COMPONENT_ACTION,
  getStatusComponentRoute,
} = require("../bot/handlers/raid-status/components/component-routes");
const {
  createStatusComponentRouteHandlers,
} = require("../bot/handlers/raid-status/components/component-handlers");
const {
  createRaidStatusComponentLayout,
} = require("../bot/handlers/raid-status/components/component-layout");
const {
  createRaidStatusRenderPayload,
} = require("../bot/handlers/raid-status/view/render-payload");
const {
  buildLocalSyncViewEmbed,
  buildLocalSyncViewRows,
  parseLocalSyncViewCustomId,
} = require("../bot/handlers/raid-status/sync/local-sync-view");
const {
  UI,
  formatGold,
  truncateText,
} = require("../bot/utils/raid/common/shared");

const JOB_ID = "job-abc";

function makeSnapshot(overrides = {}) {
  return {
    activeScope: "full",
    readerUrl: "https://example.test/sync?token=t",
    job: {
      jobId: JOB_ID,
      discordId: "viewer",
      scope: "full",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      deltas: [],
    },
    summary: { changes: { chars: 1, raids: 2, gates: 3 } },
    ...overrides,
  };
}

function viewDeps() {
  return {
    lang: "vi",
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
    formatGold,
  };
}

function customIds(rows) {
  return rows.flatMap((row) =>
    row.toJSON().components.map((component) => component.custom_id || component.url)
  );
}

// ─── customId namespace ────────────────────────────────────────

test("local-sync view buttons stay out of the global router's namespace", () => {
  const rows = buildLocalSyncViewRows({ snapshot: makeSnapshot(), ...viewDeps() });
  const ids = customIds(rows);

  assert.ok(ids.includes(`status-local:apply:${JOB_ID}`));
  assert.ok(ids.includes(`status-local:cancel:${JOB_ID}`));
  assert.ok(ids.includes(`status-local:refresh:${JOB_ID}`));
  // The global router owns `local-sync:` and would editReply() its own
  // console payload over the whole /raid-status message.
  assert.equal(ids.some((id) => String(id).startsWith("local-sync:")), false);
});

test("status-local routes resolve without shadowing the bible sync button", () => {
  assert.deepEqual(getStatusComponentRoute(`status-local:apply:${JOB_ID}`), {
    customId: `status-local:apply:${JOB_ID}`,
    action: STATUS_COMPONENT_ACTION.localSyncAction,
    editDriven: true,
    redraw: true,
  });
  assert.equal(
    getStatusComponentRoute("status:sync").action,
    STATUS_COMPONENT_ACTION.sync
  );
});

test("customId parser accepts the three console actions and rejects the rest", () => {
  assert.deepEqual(parseLocalSyncViewCustomId(`status-local:apply:${JOB_ID}`), {
    action: "apply",
    jobId: JOB_ID,
  });
  assert.deepEqual(parseLocalSyncViewCustomId(`status-local:cancel:${JOB_ID}`), {
    action: "cancel",
    jobId: JOB_ID,
  });
  assert.equal(parseLocalSyncViewCustomId(`status-local:delete:${JOB_ID}`), null);
  assert.equal(parseLocalSyncViewCustomId("status-local:apply:"), null);
  assert.equal(parseLocalSyncViewCustomId(`local-sync:apply:${JOB_ID}`), null);
  assert.equal(parseLocalSyncViewCustomId(""), null);
});

// ─── Disabled state ────────────────────────────────────────────

test("no sync mode renders the disabled card with no action buttons", () => {
  const snapshot = { activeScope: null, job: null, summary: null, readerUrl: null };
  const rows = buildLocalSyncViewRows({ snapshot, ...viewDeps() });
  const embed = buildLocalSyncViewEmbed({ snapshot, ...viewDeps() });

  assert.deepEqual(rows, []);
  assert.ok(embed);
  assert.ok(embed.toJSON().description.length > 0);
});

test("an expired session greys out console buttons but keeps the reader link", () => {
  const rows = buildLocalSyncViewRows({ snapshot: makeSnapshot(), disabled: true, ...viewDeps() });
  const components = rows.flatMap((row) => row.toJSON().components);
  const actionButtons = components.filter((component) => component.custom_id);
  const linkButtons = components.filter((component) => component.url);

  assert.ok(actionButtons.length > 0);
  assert.equal(actionButtons.every((component) => component.disabled === true), true);
  // Link buttons carry the signed reader URL and lose it when disabled.
  assert.equal(linkButtons.length, 1);
  assert.notEqual(linkButtons[0].disabled, true);
});

// ─── View wiring ───────────────────────────────────────────────

function createHarness(overrides = {}) {
  const calls = { refresh: [], actions: [], reloads: 0 };
  const session = {
    currentView: "raid",
    localSyncSnapshot: null,
    accounts: [],
    currentPage: 0,
    statusUserMeta: {},
  };

  const handlers = createStatusComponentRouteHandlers({
    session,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    UI,
    User: {},
    saveWithRetry: async (fn) => fn(),
    interaction: { editReply: async () => {} },
    discordId: "viewer",
    lang: "vi",
    buildStatusUserMeta: () => ({}),
    reloadViewerAccounts: async () => {
      calls.reloads += 1;
    },
    buildEmbedAndCanvas: async () => ({}),
    buildComponents: () => [],
    runManualStatusSync: async () => ({ outcome: null }),
    formatNextCooldownRemaining: () => "",
    formatGold,
    truncateText,
    getAutoManageCooldownMs: () => 0,
    AUTO_MANAGE_SYNC_COOLDOWN_MS: 0,
    buildMyRaidDetailEmbed: () => ({}),
    refreshLocalSyncSnapshot: async (args = {}) => {
      calls.refresh.push(args);
      return makeSnapshot();
    },
    runLocalSyncAction: async (parsed) => {
      calls.actions.push(parsed);
      return overrides.actionResult || { ok: true, job: { jobId: JOB_ID }, applied: false };
    },
    ...overrides.handlerOverrides,
  });

  return { handlers, session, calls };
}

test("picking Local Sync in the dropdown loads the snapshot before switching view", async () => {
  const { handlers, session, calls } = createHarness();

  assert.deepEqual(await handlers[STATUS_COMPONENT_ACTION.viewToggle]({ values: ["sync"] }), {
    redraw: true,
  });
  assert.equal(session.currentView, "sync");
  assert.equal(calls.refresh.length, 1);
  assert.equal(session.localSyncSnapshot.job.jobId, JOB_ID);
});

test("the dropdown still falls back to the raid view for unknown values", async () => {
  const { handlers, session, calls } = createHarness();

  await handlers[STATUS_COMPONENT_ACTION.viewToggle]({ values: ["nonsense"] });
  assert.equal(session.currentView, "raid");
  assert.equal(calls.refresh.length, 0);

  await handlers[STATUS_COMPONENT_ACTION.viewToggle]({ values: ["task"] });
  assert.equal(session.currentView, "task");
});

test("applying a preview reloads the account list before the redraw", async () => {
  const { handlers, calls } = createHarness({
    actionResult: { ok: true, job: { jobId: JOB_ID }, applied: true },
  });

  const result = await handlers[STATUS_COMPONENT_ACTION.localSyncAction]({
    customId: `status-local:apply:${JOB_ID}`,
  });

  assert.deepEqual(result, { redraw: true });
  assert.deepEqual(calls.actions, [{ action: "apply", jobId: JOB_ID }]);
  // Applying writes raid progress · without the reload, toggling back to
  // the raid view would show pre-apply data.
  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.refresh, [{ jobId: JOB_ID }]);
});

test("cancelling refreshes without touching the account list", async () => {
  const { handlers, calls } = createHarness();

  await handlers[STATUS_COMPONENT_ACTION.localSyncAction]({
    customId: `status-local:cancel:${JOB_ID}`,
  });

  assert.deepEqual(calls.actions, [{ action: "cancel", jobId: JOB_ID }]);
  assert.equal(calls.reloads, 0);
});

test("a vanished job still refreshes so the stale card cannot stick", async () => {
  const { handlers, calls } = createHarness({
    actionResult: { ok: false, reason: "missing", job: null, applied: false },
  });

  const result = await handlers[STATUS_COMPONENT_ACTION.localSyncAction]({
    customId: `status-local:refresh:${JOB_ID}`,
  });

  assert.deepEqual(result, { redraw: true });
  assert.equal(calls.reloads, 0);
  assert.equal(calls.refresh.length, 1);
});

test("a malformed customId is ignored instead of redrawing", async () => {
  const { handlers, calls } = createHarness();

  const result = await handlers[STATUS_COMPONENT_ACTION.localSyncAction]({
    customId: "status-local:apply:",
  });

  assert.deepEqual(result, { redraw: false });
  assert.equal(calls.actions.length, 0);
});

// ─── Layout and render ─────────────────────────────────────────

test("the sync view shows the toggle row plus the console rows only", () => {
  const snapshot = makeSnapshot();
  const { buildComponents } = createRaidStatusComponentLayout({
    ActionRowBuilder,
    StringSelectMenuBuilder,
    truncateText,
    lang: "vi",
    buildPaginationRow: () => new ActionRowBuilder(),
    buildViewToggleRow: () => new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-view:toggle")
        .setPlaceholder("view")
        .addOptions([{ label: "raid", value: "raid" }])
    ),
    buildSharedTaskToggleRow: () => null,
    buildTaskCharFilterRow: () => null,
    buildTaskToggleRow: () => new ActionRowBuilder(),
    buildGoldCharFilterRow: () => null,
    buildGoldModeRow: () => null,
    buildGoldToggleRow: () => new ActionRowBuilder(),
    buildSyncButton: () => null,
    buildSyncRow: () => null,
    buildLocalSyncNewButton: () => null,
    buildLocalSyncRefreshButton: () => null,
    buildRosterRefreshButton: () => null,
    buildSoloCompanionButton: () => null,
    buildRaidFilterRow: () => new ActionRowBuilder(),
    buildStatusRosterFilterRow: () => new ActionRowBuilder(),
    buildMyRaidsRow: () => new ActionRowBuilder(),
    buildLocalSyncViewRows: (disabled) => buildLocalSyncViewRows({
      snapshot,
      disabled,
      ...viewDeps(),
    }),
    getAccounts: () => [{ accountName: "Main", characters: [] }],
    getCurrentPage: () => 0,
    getCurrentView: () => "sync",
    getStatusUserMeta: () => ({ localSyncEnabled: true }),
    getRaidDropdownEntries: () => [],
    getTotalRaidPending: () => 0,
    getFilterRaidId: () => null,
    getMyRaidsShaped: () => [],
  });

  const rows = buildComponents(false);
  const ids = customIds(rows);

  assert.ok(ids.includes("status-view:toggle"));
  assert.ok(ids.includes(`status-local:apply:${JOB_ID}`));
  // Actions sit above the view switcher: the card is there to act on a
  // preview, and the dropdown is navigation. Order is the behaviour, so
  // assert it rather than mere presence.
  assert.ok(
    ids.indexOf(`status-local:apply:${JOB_ID}`) < ids.indexOf("status-view:toggle"),
    "apply/cancel/refresh must render above the view dropdown"
  );
  assert.equal(
    customIds([rows[rows.length - 1]])[0],
    "status-view:toggle",
    "the view dropdown must be the last row"
  );
  // Pagination and filters belong to per-roster views · a preview is
  // account-wide, so they would imply a scope the buttons do not have.
  assert.equal(ids.includes("status-filter:raid"), false);
  assert.ok(rows.length <= 5);
});

// ─── Solo Local Reader as the second way in ────────────────────

function syncViewLayout({ soloButton = null, snapshot = makeSnapshot() } = {}) {
  return createRaidStatusComponentLayout({
    ActionRowBuilder,
    StringSelectMenuBuilder,
    truncateText,
    lang: "vi",
    buildPaginationRow: () => new ActionRowBuilder(),
    buildViewToggleRow: () => new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-view:toggle")
        .setPlaceholder("view")
        .addOptions([{ label: "raid", value: "raid" }])
    ),
    buildSharedTaskToggleRow: () => null,
    buildTaskCharFilterRow: () => null,
    buildTaskToggleRow: () => new ActionRowBuilder(),
    buildGoldCharFilterRow: () => null,
    buildGoldModeRow: () => null,
    buildGoldToggleRow: () => new ActionRowBuilder(),
    buildSyncButton: () => null,
    buildSyncRow: () => null,
    buildLocalSyncNewButton: () => null,
    buildLocalSyncRefreshButton: () => null,
    buildRosterRefreshButton: () => null,
    buildSoloCompanionButton: () => soloButton,
    buildRaidFilterRow: () => new ActionRowBuilder(),
    buildStatusRosterFilterRow: () => new ActionRowBuilder(),
    buildMyRaidsRow: () => new ActionRowBuilder(),
    buildLocalSyncViewRows: (disabled) => buildLocalSyncViewRows({ snapshot, disabled, ...viewDeps() }),
    getAccounts: () => [{ accountName: "Main", characters: [] }],
    getCurrentPage: () => 0,
    getCurrentView: () => "sync",
    getStatusUserMeta: () => ({ localSyncEnabled: true }),
    getRaidDropdownEntries: () => [],
    getTotalRaidPending: () => 0,
    getFilterRaidId: () => null,
    getMyRaidsShaped: () => [],
  });
}

test("Solo Local Reader shows up in the sync view when it builds", () => {
  const solo = new ButtonBuilder()
    .setCustomId("status:solo-companion")
    .setLabel("Solo Local Reader")
    .setStyle(ButtonStyle.Secondary);
  const ids = customIds(syncViewLayout({ soloButton: solo }).buildComponents(false));

  assert.ok(ids.includes("status:solo-companion"));
  // Still above the dropdown · it is an alternative way in, not navigation.
  assert.ok(ids.indexOf("status:solo-companion") < ids.indexOf("status-view:toggle"));
});

test("no Solo Local Reader button means no empty row in the sync view", () => {
  // buildSoloCompanionButton returns null for full local-sync users, and a
  // null must not leave a stray ActionRow behind.
  const rows = syncViewLayout({ soloButton: null }).buildComponents(false);
  const ids = customIds(rows);

  assert.equal(ids.includes("status:solo-companion"), false);
  assert.ok(rows.every((row) => row.toJSON().components.length > 0), "no empty action rows");
});

test("the sync view skips the roster background image", async () => {
  const snapshot = makeSnapshot();
  // resolveBackgroundLookup reads accountName and nothing else does on
  // this path, so a throwing getter is a tripwire for entering the
  // background loader. It also keeps the contrast case fast · the throw
  // lands before the loader's 10s Mongo timeout.
  const TRIPWIRE = new Error("background loader entered");
  const makeTripwireAccount = () => ({
    characters: [],
    get accountName() {
      throw TRIPWIRE;
    },
  });
  const makePayloadFor = (view) => createRaidStatusRenderPayload({
    discordId: "viewer",
    getAccounts: () => [makeTripwireAccount()],
    getCurrentPage: () => 0,
    getCurrentView: () => view,
    getFilterRaidId: () => null,
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: () => [],
    getTotalCharacters: () => 0,
    summarizeRaidProgress: () => ({}),
    summarizeGlobalGold: () => ({}),
    buildAccountPageEmbed: () => new EmbedBuilder().setTitle("raid"),
    buildGoldViewEmbed: () => new EmbedBuilder().setTitle("gold"),
    buildTaskViewEmbed: () => new EmbedBuilder().setTitle("task"),
    buildLocalSyncViewEmbed: () => buildLocalSyncViewEmbed({ snapshot, ...viewDeps() }),
    lang: "vi",
  });

  const payload = await makePayloadFor("sync").buildEmbedAndCanvas();

  assert.deepEqual(payload.files, []);
  assert.equal(payload.embeds[0].toJSON().image, undefined);

  // Contrast: the raid view does reach the loader, which is what makes
  // the assertions above meaningful rather than vacuous.
  await assert.rejects(
    () => makePayloadFor("raid").buildEmbedAndCanvas(),
    (err) => err === TRIPWIRE
  );
});

test("the sync view falls back to the raid embed when no snapshot loaded", () => {
  const { buildCurrentEmbed } = createRaidStatusRenderPayload({
    discordId: "viewer",
    getAccounts: () => [{ accountName: "Main", characters: [] }],
    getCurrentPage: () => 0,
    getCurrentView: () => "sync",
    getFilterRaidId: () => null,
    getStatusUserMeta: () => ({}),
    baseGetRaidsFor: () => [],
    getTotalCharacters: () => 0,
    summarizeRaidProgress: () => ({}),
    summarizeGlobalGold: () => ({}),
    buildAccountPageEmbed: () => new EmbedBuilder().setTitle("raid"),
    buildGoldViewEmbed: () => new EmbedBuilder().setTitle("gold"),
    buildTaskViewEmbed: () => new EmbedBuilder().setTitle("task"),
    buildLocalSyncViewEmbed: () => null,
    lang: "vi",
  });

  // The collector's end hook re-renders through this path and must not
  // throw on a session that expired mid-fetch.
  assert.equal(buildCurrentEmbed().toJSON().title, "raid");
});
