"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const discord = require("discord.js");

const User = require("../bot/models/user");
const { createStatusComponentRouteHandlers } = require("../bot/handlers/raid-status/components/component-handlers");
const { STATUS_COMPONENT_ACTION } = require("../bot/handlers/raid-status/components/component-routes");
const {
  replaceRaidGoldSelection,
  setParsedGoldRaidMode,
  toggleParsedGoldRaid,
} = require("../bot/handlers/raid-status/gold/gold-actions");
const { getTargetResetKey } = require("../bot/services/raid/schedulers/weekly-reset");
const { dailyResetStartMs } = require("../bot/utils/raid/schedule/reset-windows");
const { UI, formatGold, truncateText } = require("../bot/utils/raid/common/shared");

const { saveWithRetry } = User;

// A write to a shared roster is checked when the click arrives. When its
// first save loses a version race, the retry runs later, and the owner may
// have revoked the share in between; the retry must not commit.

function makeOwnerDoc() {
  const doc = new User({
    discordId: "owner",
    weeklyResetKey: getTargetResetKey(),
    accounts: [{
      accountName: "Roster",
      characters: [{
        id: "c1",
        name: "Aki",
        class: "Aeromancer",
        itemLevel: 1720,
        sideTasks: [{ taskId: "daily", name: "Daily", reset: "daily", completed: false, lastResetAt: dailyResetStartMs() }],
        assignedRaids: {
          armoche: { modeKey: "normal", G1: { difficulty: "Normal", completedDate: 1 }, G2: {} },
          kazeros: { modeKey: "normal", G1: { difficulty: "Normal", completedDate: 1 }, G2: {} },
          horizon: { modeKey: "normal" },
        },
      }],
    }],
  });
  return doc;
}

// The first save throws VersionError and the owner revokes the share while
// the retry waits.
function revokedDuringRetry() {
  const access = { granted: true };
  const stats = { saves: 0, committedAfterRevocation: 0 };
  const model = {
    async findOne() {
      const doc = makeOwnerDoc();
      doc.save = async () => {
        stats.saves += 1;
        if (stats.saves === 1) {
          access.granted = false;
          const error = new Error("concurrent write");
          error.name = "VersionError";
          throw error;
        }
        if (!access.granted) stats.committedAfterRevocation += 1;
        return doc;
      };
      return doc;
    },
  };
  return { access, stats, model, canWrite: async () => access.granted };
}

// The shares the owner still has with the viewer, as getAccessibleAccounts
// returns them: none once revoked, one view entry once downgraded.
const NO_SHARES = async () => [];
const VIEW_SHARE = async () => [{ ownerDiscordId: "owner", accessLevel: "view", isOwn: false }];

async function toggleTaskWhileShareIsCutDuringRetry(getAccessibleAccountsFn) {
  const { stats, model, canWrite } = revokedDuringRetry();
  const notices = [];
  const handlers = createStatusComponentRouteHandlers({
    ...discord,
    UI,
    User: model,
    saveWithRetry,
    session: {
      accounts: [{
        accountName: "Roster",
        _sharedFrom: { ownerDiscordId: "owner", level: "edit", ownerLabel: "Owner" },
        characters: [{ name: "Aki" }],
      }],
      currentPage: 0,
    },
    discordId: "viewer",
    lang: "en",
    interaction: { editReply: async () => {} },
    reloadViewerAccounts: async () => {},
    buildEmbedAndCanvas: async () => ({}),
    buildComponents: () => [],
    canEditAccountFn: (_viewer, _owner) => canWrite(),
    getAccessibleAccountsFn,
    formatGold,
    truncateText,
  });

  await handlers[STATUS_COMPONENT_ACTION.taskToggle]({
    values: ["Aki::daily"],
    followUp: async (payload) => { notices.push(payload); },
  });

  assert.equal(stats.committedAfterRevocation, 0);
  assert.equal(stats.saves, 1);
  return JSON.stringify(notices);
}

test("a raid-status task toggle retried after the share was revoked writes nothing and says the share was removed", async () => {
  const notices = await toggleTaskWhileShareIsCutDuringRetry(NO_SHARES);

  assert.match(notices, /Share removed/);
  assert.match(notices, /can't update side tasks/);
  assert.doesNotMatch(notices, /Share is view-only/);
});

test("a raid-status task toggle retried after the share was downgraded writes nothing and says the share is view-only", async () => {
  const notices = await toggleTaskWhileShareIsCutDuringRetry(VIEW_SHARE);

  assert.match(notices, /Share is view-only/);
  assert.doesNotMatch(notices, /Share removed/);
});

test("raid-status gold writes retried after the share was revoked commit nothing", async () => {
  const operations = {
    toggle: (options) => toggleParsedGoldRaid({
      ...options,
      parsed: { kind: "single", targetCharName: "Aki", raidKey: "kazeros" },
    }),
    mode: (options) => setParsedGoldRaidMode({
      ...options,
      targetCharName: "Aki",
      raidKey: "armoche",
      modeKey: "hard",
    }),
    replace: (options) => replaceRaidGoldSelection({
      ...options,
      targetCharName: "Aki",
      includeRaidKey: "horizon",
      excludeRaidKey: "armoche",
    }),
  };
  for (const [label, run] of Object.entries(operations)) {
    const { stats, model, canWrite } = revokedDuringRetry();
    const result = await run({
      User: model,
      saveWithRetry,
      discordId: "owner",
      targetAccountName: "Roster",
      canWrite,
    });
    assert.equal(stats.committedAfterRevocation, 0, label);
    assert.equal(result.ok, false, label);
  }
});

function makeGoldSelectHandlers({
  model,
  canEditAccountFn,
  getAccessibleAccountsFn = async () => assert.fail("only a refused share asks which shares are left"),
  shared = true,
  accountName = "Roster",
}) {
  return createStatusComponentRouteHandlers({
    ...discord,
    UI,
    User: model,
    saveWithRetry,
    session: {
      accounts: [{
        accountName,
        ...(shared && { _sharedFrom: { ownerDiscordId: "owner", accessLevel: "edit", ownerLabel: "Owner" } }),
        characters: [{ name: "Aki" }],
      }],
      currentPage: 0,
    },
    discordId: "viewer",
    lang: "en",
    interaction: { editReply: async () => {} },
    reloadViewerAccounts: async () => {},
    buildEmbedAndCanvas: async () => ({}),
    buildComponents: () => [],
    canEditAccountFn,
    getAccessibleAccountsFn,
    formatGold,
    truncateText,
  });
}

const GOLD_SELECTS = {
  toggle: {
    action: STATUS_COMPONENT_ACTION.goldToggle,
    value: "Aki::kazeros",
    failedNotice: /Couldn't update received gold/,
  },
  mode: {
    action: STATUS_COMPONENT_ACTION.goldMode,
    value: "Aki::armoche::hard",
    failedNotice: /Couldn't save/,
  },
};

const GOLD_VIEW_ONLY_DESCRIPTION = /change its gold settings/;
const GOLD_REVOKED_TITLE = /Share removed/;
const GOLD_REVOKED_DESCRIPTION = /no longer shares this roster/;

for (const [label, select] of Object.entries(GOLD_SELECTS)) {
  test(`raid-status gold ${label} on a share downgraded before the click says the share is view-only`, async () => {
    const notices = [];
    const handlers = makeGoldSelectHandlers({
      model: { findOne: async () => assert.fail("a refused share must not load the owner document") },
      canEditAccountFn: async () => false,
      getAccessibleAccountsFn: VIEW_SHARE,
    });

    await handlers[select.action]({
      values: [select.value],
      followUp: async (payload) => { notices.push(payload); },
    });

    assert.match(JSON.stringify(notices), /Share is view-only/);
    assert.match(JSON.stringify(notices), GOLD_VIEW_ONLY_DESCRIPTION);
    assert.doesNotMatch(JSON.stringify(notices), GOLD_REVOKED_TITLE);
  });

  test(`raid-status gold ${label} on a share revoked before the click says the share was removed`, async () => {
    const notices = [];
    const handlers = makeGoldSelectHandlers({
      model: { findOne: async () => assert.fail("a refused share must not load the owner document") },
      canEditAccountFn: async () => false,
      getAccessibleAccountsFn: NO_SHARES,
    });

    await handlers[select.action]({
      values: [select.value],
      followUp: async (payload) => { notices.push(payload); },
    });

    assert.match(JSON.stringify(notices), GOLD_REVOKED_TITLE);
    assert.match(JSON.stringify(notices), GOLD_REVOKED_DESCRIPTION);
    assert.match(JSON.stringify(notices), /Owner/);
    assert.doesNotMatch(JSON.stringify(notices), /Share is view-only/);
  });

  test(`raid-status gold ${label} retried after the share was revoked says the share was removed`, async () => {
    const { stats, model, canWrite } = revokedDuringRetry();
    const notices = [];
    const handlers = makeGoldSelectHandlers({
      model,
      canEditAccountFn: () => canWrite(),
      getAccessibleAccountsFn: NO_SHARES,
    });

    await handlers[select.action]({
      values: [select.value],
      followUp: async (payload) => { notices.push(payload); },
    });

    assert.equal(stats.saves, 1);
    assert.equal(stats.committedAfterRevocation, 0);
    assert.match(JSON.stringify(notices), GOLD_REVOKED_TITLE);
    assert.match(JSON.stringify(notices), GOLD_REVOKED_DESCRIPTION);
    assert.doesNotMatch(JSON.stringify(notices), /Share is view-only/);
    assert.doesNotMatch(JSON.stringify(notices), select.failedNotice);
  });

  test(`raid-status gold ${label} retried after the share was downgraded says the share is view-only`, async () => {
    const { stats, model, canWrite } = revokedDuringRetry();
    const notices = [];
    const handlers = makeGoldSelectHandlers({
      model,
      canEditAccountFn: () => canWrite(),
      getAccessibleAccountsFn: VIEW_SHARE,
    });

    await handlers[select.action]({
      values: [select.value],
      followUp: async (payload) => { notices.push(payload); },
    });

    assert.equal(stats.saves, 1);
    assert.equal(stats.committedAfterRevocation, 0);
    assert.match(JSON.stringify(notices), /Share is view-only/);
    assert.match(JSON.stringify(notices), GOLD_VIEW_ONLY_DESCRIPTION);
    assert.doesNotMatch(JSON.stringify(notices), select.failedNotice);
  });

  test(`raid-status gold ${label} keeps the save-failed notice for a real save failure`, async () => {
    const notices = [];
    const model = {
      async findOne() {
        const doc = makeOwnerDoc();
        doc.save = async () => { throw new Error("disk full"); };
        return doc;
      },
    };
    const handlers = makeGoldSelectHandlers({ model, canEditAccountFn: async () => true });

    await handlers[select.action]({
      values: [select.value],
      followUp: async (payload) => { notices.push(payload); },
    });

    assert.match(JSON.stringify(notices), select.failedNotice);
    assert.doesNotMatch(JSON.stringify(notices), /Share is view-only/);
  });

  test(`raid-status gold ${label} stays silent when the card has no roster to write`, async () => {
    const notices = [];
    const handlers = makeGoldSelectHandlers({
      model: { findOne: async () => assert.fail("no roster means no write") },
      canEditAccountFn: async () => false,
      shared: false,
      accountName: "",
    });

    await handlers[select.action]({
      values: [select.value],
      followUp: async (payload) => { notices.push(payload); },
    });

    assert.deepEqual(notices, []);
  });
}
