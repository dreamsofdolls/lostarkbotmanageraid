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

class FakeEmbedBuilder {
  setColor(value) {
    this.color = value;
    return this;
  }

  setTitle(value) {
    this.title = value;
    return this;
  }

  setDescription(value) {
    this.description = value;
    return this;
  }
}

function createHandlerHarness(overrides = {}) {
  const taskFilters = new Map();
  const goldFilters = new Map();
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
    setGoldCharFilterForPage(page, value) {
      goldFilters.set(page, value);
    },
    ...(overrides.session || {}),
  };
  let reloadCount = 0;

  const handlers = createStatusComponentRouteHandlers({
    session,
    EmbedBuilder: FakeEmbedBuilder,
    UI: {},
    User: overrides.User || {},
    saveWithRetry: overrides.saveWithRetry || (async (fn) => fn()),
    interaction: { editReply: async () => {} },
    discordId: "viewer",
    lang: "vi",
    buildStatusUserMeta: () => ({}),
    reloadViewerAccounts: overrides.reloadViewerAccounts || (async () => {
      reloadCount += 1;
    }),
    buildEmbedAndCanvas: async () => ({}),
    buildComponents: () => [],
    runManualStatusSync: async () => ({ outcome: null }),
    formatNextCooldownRemaining: () => "",
    getAutoManageCooldownMs: () => 0,
    AUTO_MANAGE_SYNC_COOLDOWN_MS: 0,
    buildMyRaidDetailEmbed: () => ({}),
  });

  return { handlers, session, taskFilters, goldFilters, get reloadCount() { return reloadCount; } };
}

test("raid-status component handlers move pagination through session state", async () => {
  const { handlers, session } = createHandlerHarness();

  assert.deepEqual(await handlers[STATUS_COMPONENT_ACTION.prev](), { redraw: true });
  assert.equal(session.currentPage, 0);

  assert.deepEqual(await handlers[STATUS_COMPONENT_ACTION.next](), { redraw: true });
  assert.equal(session.currentPage, 1);
});

test("raid-status component handlers update filter and task view state", async () => {
  const { handlers, session, taskFilters, goldFilters } = createHandlerHarness();

  await handlers[STATUS_COMPONENT_ACTION.raidFilter]({ values: ["serca"] });
  assert.equal(session.filterRaidId, "serca");

  await handlers[STATUS_COMPONENT_ACTION.raidFilter]({ values: [FILTER_ALL_RAIDS] });
  assert.equal(session.filterRaidId, null);

  await handlers[STATUS_COMPONENT_ACTION.viewToggle]({ values: ["task"] });
  assert.equal(session.currentView, "task");

  await handlers[STATUS_COMPONENT_ACTION.taskCharFilter]({ values: ["Aki"] });
  assert.equal(taskFilters.get(session.currentPage), "Aki");

  await handlers[STATUS_COMPONENT_ACTION.viewToggle]({ values: ["gold"] });
  assert.equal(session.currentView, "gold");

  await handlers[STATUS_COMPONENT_ACTION.goldCharFilter]({ values: ["Goldie"] });
  assert.equal(goldFilters.get(session.currentPage), "Goldie");
});

test("raid-status component handlers persist gold toggle and request redraw", async () => {
  let saved = 0;
  let markedPath = "";
  const doc = {
    accounts: [
      {
        accountName: "Roster B",
        characters: [
          {
            name: "Goldie",
            itemLevel: 1739,
            assignedRaids: {
              horizon: {
                modeKey: "hard",
                G1: { difficulty: "Hard", completedDate: 1 },
                G2: { difficulty: "Hard", completedDate: 1 },
              },
            },
          },
        ],
      },
    ],
    markModified(path) {
      markedPath = path;
    },
    async save() {
      saved += 1;
    },
  };
  const harness = createHandlerHarness({
    User: {
      async findOne(query) {
        assert.deepEqual(query, { discordId: "viewer" });
        return doc;
      },
    },
  });

  const result = await harness.handlers[STATUS_COMPONENT_ACTION.goldToggle]({
    values: ["Goldie::horizon"],
  });

  assert.deepEqual(result, { redraw: true });
  assert.equal(doc.accounts[0].characters[0].assignedRaids.horizon.goldOverride, "include");
  assert.equal(markedPath, "accounts");
  assert.equal(saved, 1);
  assert.equal(harness.reloadCount, 1);
});

test("raid-status component handlers warn when gold toggle cannot be saved", async () => {
  let followUpPayload = null;
  const harness = createHandlerHarness({
    User: {
      async findOne() {
        return { accounts: [] };
      },
    },
  });

  const result = await harness.handlers[STATUS_COMPONENT_ACTION.goldToggle]({
    values: ["Goldie::horizon"],
    async followUp(payload) {
      followUpPayload = payload;
    },
  });

  assert.deepEqual(result, { redraw: false });
  assert.equal(harness.reloadCount, 0);
  assert.ok(followUpPayload, "expected warning follow-up when gold toggle is not saved");
  assert.equal(followUpPayload.flags, 64);
});
