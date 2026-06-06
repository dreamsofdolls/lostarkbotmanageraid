"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STATUS_COMPONENT_ACTION,
} = require("../bot/handlers/raid-status/components/component-routes");
const {
  createStatusComponentRouteHandlers,
} = require("../bot/handlers/raid-status/components/component-handlers");
const {
  FILTER_ALL_RAIDS,
} = require("../bot/handlers/raid-status/raid-filter");

function createHandlerHarness() {
  const taskFilters = new Map();
  const session = {
    accounts: [{ accountName: "Roster A" }, { accountName: "Roster B" }],
    currentPage: 1,
    filterRaidId: null,
    currentView: "raid",
    statusUserMeta: {},
    userDoc: { accounts: [] },
    cachedUrl: null,
    setCachedLocalSyncResumeUrl(value) {
      this.cachedUrl = value;
    },
    setTaskCharFilterForPage(page, value) {
      taskFilters.set(page, value);
    },
  };

  const handlers = createStatusComponentRouteHandlers({
    session,
    EmbedBuilder: class {},
    UI: {},
    User: {},
    saveWithRetry: async (fn) => fn(),
    interaction: { editReply: async () => {} },
    discordId: "viewer",
    lang: "vi",
    buildStatusUserMeta: () => ({}),
    reloadViewerAccounts: async () => {},
    buildEmbedAndCanvas: async () => ({}),
    buildComponents: () => [],
    runManualStatusSync: async () => ({ outcome: null }),
    formatNextCooldownRemaining: () => "",
    getAutoManageCooldownMs: () => 0,
    AUTO_MANAGE_SYNC_COOLDOWN_MS: 0,
    buildMyRaidDetailEmbed: () => ({}),
  });

  return { handlers, session, taskFilters };
}

test("raid-status component handlers move pagination through session state", async () => {
  const { handlers, session } = createHandlerHarness();

  assert.deepEqual(await handlers[STATUS_COMPONENT_ACTION.prev](), { redraw: true });
  assert.equal(session.currentPage, 0);

  assert.deepEqual(await handlers[STATUS_COMPONENT_ACTION.next](), { redraw: true });
  assert.equal(session.currentPage, 1);
});

test("raid-status component handlers update filter and task view state", async () => {
  const { handlers, session, taskFilters } = createHandlerHarness();

  await handlers[STATUS_COMPONENT_ACTION.raidFilter]({ values: ["serca"] });
  assert.equal(session.filterRaidId, "serca");

  await handlers[STATUS_COMPONENT_ACTION.raidFilter]({ values: [FILTER_ALL_RAIDS] });
  assert.equal(session.filterRaidId, null);

  await handlers[STATUS_COMPONENT_ACTION.viewToggle]({ values: ["task"] });
  assert.equal(session.currentView, "task");

  await handlers[STATUS_COMPONENT_ACTION.taskCharFilter]({ values: ["Aki"] });
  assert.equal(taskFilters.get(session.currentPage), "Aki");
});
