"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");

const {
  STATUS_COMPONENT_ACTION,
} = require("../bot/handlers/raid-status/components/component-routes");
const {
  createStatusComponentRouteHandlers,
} = require("../bot/handlers/raid-status/components/component-handlers");
const {
  FILTER_ALL_RAIDS,
} = require("../bot/handlers/raid-status/raid-filter");
const {
  UI,
  formatGold,
  truncateText,
} = require("../bot/utils/raid/common/shared");

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

function getSelectCustomId(row) {
  const select = row?.components?.[0];
  return select?.data?.custom_id || select?.data?.customId || select?.customId || "";
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
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    User: overrides.User || {},
    saveWithRetry: overrides.saveWithRetry || (async (fn) => fn()),
    interaction: overrides.interaction || { editReply: async () => {} },
    discordId: "viewer",
    lang: "vi",
    buildStatusUserMeta: () => ({}),
    reloadViewerAccounts: overrides.reloadViewerAccounts || (async () => {
      reloadCount += 1;
    }),
    buildEmbedAndCanvas: overrides.buildEmbedAndCanvas || (async () => ({})),
    buildComponents: overrides.buildComponents || (() => []),
    runManualStatusSync: async () => ({ outcome: null }),
    formatNextCooldownRemaining: () => "",
    formatGold,
    truncateText,
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
            itemLevel: 1700,
            assignedRaids: {
              horizon: {
                modeKey: "normal",
                G1: { difficulty: "Level 1", completedDate: 1 },
                G2: { difficulty: "Level 1", completedDate: 1 },
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
  let followUpPayload = null;

  const result = await harness.handlers[STATUS_COMPONENT_ACTION.goldToggle]({
    values: ["Goldie::horizon"],
    async followUp(payload) {
      followUpPayload = payload;
    },
  });

  assert.deepEqual(result, { redraw: true });
  assert.equal(doc.accounts[0].characters[0].assignedRaids.horizon.goldOverride, "include");
  assert.equal(markedPath, "accounts");
  assert.equal(saved, 1);
  assert.equal(harness.reloadCount, 1);
  assert.match(followUpPayload.embeds[0].title, /Đã cập nhật gold nhận/);
});

test("raid-status component handlers prompt for a gold replacement when locked raid would exceed 3/3", async () => {
  let saved = 0;
  const doc = {
    accounts: [
      {
        accountName: "Roster B",
        characters: [
          {
            name: "Goldie",
            itemLevel: 1730,
            assignedRaids: {
              horizon: {
                modeKey: "hard",
                G1: { difficulty: "Level 2", completedDate: null },
                G2: { difficulty: "Level 2", completedDate: null },
              },
            },
          },
        ],
      },
    ],
    markModified(path) {
      assert.equal(path, "accounts");
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
    interaction: {
      async editReply(payload) {
        promptPayload = payload;
      },
    },
  });
  let promptPayload = null;
  let finalPromptPayload = null;

  const result = await harness.handlers[STATUS_COMPONENT_ACTION.goldToggle]({
    values: ["Goldie::horizon"],
    user: { id: "viewer" },
  });

  assert.deepEqual(result, { redraw: false });
  assert.equal(promptPayload.components.length, 1);
  assert.match(promptPayload.embeds[0].title, /3\/3/);
  assert.equal(saved, 0);
  assert.equal(harness.reloadCount, 0);

  const selectId = getSelectCustomId(promptPayload.components[0]);
  const replaceResult = await harness.handlers[STATUS_COMPONENT_ACTION.goldReplace]({
    customId: selectId,
    user: { id: "viewer" },
    values: ["armoche"],
    async followUp(payload) {
      finalPromptPayload = payload;
    },
  });

  assert.deepEqual(replaceResult, { redraw: true });
  assert.equal(doc.accounts[0].characters[0].assignedRaids.horizon.goldOverride, "include");
  assert.equal(doc.accounts[0].characters[0].assignedRaids.armoche.goldOverride, "exclude");
  assert.equal(saved, 1);
  assert.equal(harness.reloadCount, 1);
  assert.match(finalPromptPayload.embeds[0].title, /Đổi gold nhận xong/);
});

test("raid-status component handlers pass saved replacement docs into reload before redraw", async () => {
  let saved = 0;
  let reloadCount = 0;
  let reloadedDoc = null;
  let originalEditPayload = null;
  const doc = {
    accounts: [
      {
        accountName: "Roster B",
        characters: [
          {
            name: "Goldie",
            itemLevel: 1730,
            assignedRaids: {
              horizon: {
                modeKey: "hard",
                G1: { difficulty: "Level 2", completedDate: null },
                G2: { difficulty: "Level 2", completedDate: null },
              },
            },
          },
        ],
      },
    ],
    markModified(path) {
      assert.equal(path, "accounts");
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
    async reloadViewerAccounts(nextOwnDoc) {
      reloadCount += 1;
      reloadedDoc = nextOwnDoc;
    },
    interaction: {
      async editReply(payload) {
        originalEditPayload = payload;
        promptPayload = payload;
      },
    },
  });
  let promptPayload = null;
  let finalEditPayload = null;

  const promptResult = await harness.handlers[STATUS_COMPONENT_ACTION.goldToggle]({
    values: ["Goldie::horizon"],
    user: { id: "viewer" },
  });

  assert.deepEqual(promptResult, { redraw: false });

  const selectId = getSelectCustomId(promptPayload.components[0]);
  assert.match(selectId, /^status-gold:replace:/);
  const result = await harness.handlers[STATUS_COMPONENT_ACTION.goldReplace]({
    customId: selectId,
    user: { id: "viewer" },
    values: ["armoche"],
    async followUp(payload) {
      finalEditPayload = payload;
    },
  });

  assert.deepEqual(result, { redraw: true });
  assert.equal(doc.accounts[0].characters[0].assignedRaids.horizon.goldOverride, "include");
  assert.equal(doc.accounts[0].characters[0].assignedRaids.armoche.goldOverride, "exclude");
  assert.equal(saved, 1);
  assert.equal(reloadCount, 1);
  assert.equal(reloadedDoc, doc);
  assert.match(originalEditPayload.embeds[0].title, /3\/3/);
  assert.equal(originalEditPayload.components.length, 1);
  assert.match(finalEditPayload.embeds[0].title, /Đổi gold nhận xong/);
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
