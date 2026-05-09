process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require("discord.js");

const { createRaidAutoManageCommand } = require("../bot/handlers/raid-auto-manage");
const { UI, normalizeName } = require("../bot/utils/raid/shared");

function makeUserStub(doc) {
  return {
    findOne: () => ({
      lean: () => Promise.resolve(doc),
    }),
  };
}

function makeCommand(User, overrides = {}) {
  return createRaidAutoManageCommand({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User,
    normalizeName,
    saveWithRetry: async (op) => op(),
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {},
    ...overrides,
  });
}

test("raid-auto-manage action:sync rejects while local-sync is active", async () => {
  const replies = [];
  const { handleRaidAutoManageCommand } = makeCommand(
    makeUserStub({ language: "vi", localSyncEnabled: true, autoManageEnabled: false })
  );
  await handleRaidAutoManageCommand({
    user: { id: "u-local" },
    options: {
      getString: (name) => (name === "action" ? "sync" : null),
    },
    reply: async (payload) => {
      replies.push(payload);
    },
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, 64);
  assert.match(replies[0].embeds[0].data.title, /local-sync/i);
  assert.match(replies[0].embeds[0].data.description, /Web Companion/);
});

test("raid-auto-manage autocomplete hides bible sync while local-sync is active", async () => {
  const responses = [];
  const { handleRaidAutoManageAutocomplete } = makeCommand(
    makeUserStub({ language: "vi", localSyncEnabled: true, autoManageEnabled: false })
  );

  await handleRaidAutoManageAutocomplete({
    user: { id: "u-local" },
    options: {
      getFocused: () => ({ name: "action", value: "" }),
    },
    respond: async (choices) => {
      responses.push(choices);
    },
  });

  assert.equal(responses.length, 1);
  // `reset` always shows (its destructive nature is gated by the
  // in-handler confirmation prompt, not by hiding from autocomplete);
  // local-on is hidden because local is already on; bible-on path is
  // hidden because mutex would reject it; sync is also hidden via the
  // legacy autocomplete filter when bible is off; local-off / status
  // / reset are the survivors.
  assert.deepEqual(
    responses[0].map((choice) => choice.value),
    ["status", "local-off", "reset"]
  );
});

test("raid-auto-manage action:reset serializes with bible sync slot and wipes sync state", async () => {
  let saved = 0;
  const doc = {
    language: "vi",
    autoManageEnabled: true,
    localSyncEnabled: true,
    localSyncLinkedAt: 111,
    lastAutoManageSyncAt: 222,
    lastAutoManageAttemptAt: 333,
    lastLocalSyncAt: 444,
    lastLocalSyncToken: "old-token",
    lastLocalSyncTokenExpAt: 999,
    lastPrivateLogNudgeAt: 555,
    accounts: [
      {
        accountName: "Roster",
        lastRefreshedAt: 666,
        lastRefreshAttemptAt: 777,
        sharedTasks: [{ taskId: "s1" }],
        characters: [
          {
            id: "c1",
            name: "Aki",
            class: "Artist",
            itemLevel: 1750,
            assignedRaids: { kazeros: { G1: { difficulty: "Hard", completedDate: 123 } } },
            publicLogDisabled: true,
            bibleSerial: "serial",
            bibleCid: 1,
            bibleRid: 2,
            sideTasks: [{ taskId: "t1" }],
          },
        ],
      },
    ],
    async save() {
      saved += 1;
      return this;
    },
  };
  const User = {
    findOne() {
      return {
        lean: async () => ({ language: "vi" }),
        then(resolve, reject) {
          return Promise.resolve(doc).then(resolve, reject);
        },
      };
    },
  };
  const guardCalls = [];
  const releases = [];
  const edits = [];
  const { handleRaidAutoManageCommand } = makeCommand(User, {
    acquireAutoManageSyncSlot: async (discordId, opts) => {
      guardCalls.push({ discordId, opts });
      return { acquired: true };
    },
    releaseAutoManageSyncSlot: (discordId) => releases.push(discordId),
  });

  await handleRaidAutoManageCommand({
    user: { id: "u-reset" },
    options: {
      getString: (name) => (name === "action" ? "reset" : null),
    },
    reply: async () => {},
    fetchReply: async () => ({
      awaitMessageComponent: async () => ({
        user: { id: "u-reset" },
        customId: "auto-manage:reset-confirm",
        deferUpdate: async () => {},
      }),
    }),
    editReply: async (payload) => {
      edits.push(payload);
    },
  });

  assert.equal(saved, 1);
  assert.deepEqual(guardCalls, [{ discordId: "u-reset", opts: { ignoreCooldown: true } }]);
  assert.deepEqual(releases, ["u-reset"]);
  assert.equal(doc.autoManageEnabled, false);
  assert.equal(doc.localSyncEnabled, false);
  assert.equal(doc.lastLocalSyncToken, null);
  assert.deepEqual(doc.accounts[0].characters[0].assignedRaids, { armoche: {}, kazeros: {}, serca: {} });
  assert.equal(doc.accounts[0].characters[0].publicLogDisabled, false);
  assert.equal(doc.accounts[0].characters[0].bibleSerial, null);
  assert.equal(doc.accounts[0].characters[0].sideTasks.length, 1);
  assert.match(edits.at(-1).embeds[0].data.title, /Reset/);
});

test("raid-auto-manage action:reset refuses while a bible sync is in flight", async () => {
  let saved = 0;
  const doc = {
    language: "vi",
    accounts: [],
    async save() {
      saved += 1;
    },
  };
  const User = {
    findOne() {
      return {
        lean: async () => ({ language: "vi" }),
        then(resolve, reject) {
          return Promise.resolve(doc).then(resolve, reject);
        },
      };
    },
  };
  const edits = [];
  const { handleRaidAutoManageCommand } = makeCommand(User, {
    acquireAutoManageSyncSlot: async () => ({ acquired: false, reason: "in-flight" }),
  });

  await handleRaidAutoManageCommand({
    user: { id: "u-reset-busy" },
    options: {
      getString: (name) => (name === "action" ? "reset" : null),
    },
    reply: async () => {},
    fetchReply: async () => ({
      awaitMessageComponent: async () => ({
        user: { id: "u-reset-busy" },
        customId: "auto-manage:reset-confirm",
        deferUpdate: async () => {},
      }),
    }),
    editReply: async (payload) => {
      edits.push(payload);
    },
  });

  assert.equal(saved, 0);
  assert.match(edits.at(-1).embeds[0].data.title, /Reset/);
});
