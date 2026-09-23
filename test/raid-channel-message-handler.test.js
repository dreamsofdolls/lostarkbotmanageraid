"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MESSAGE_DEDUP_MAX_PERSISTED_IDS,
  createRaidChannelMessageHandler,
} = require("../bot/services/raid/channel-monitor/channel-monitor-message-handler");
const { UI } = require("../bot/utils/raid/common/shared");

function makeHandler(overrides = {}) {
  const calls = {
    emptyWarnings: 0,
    parses: 0,
    spamWarnings: 0,
  };
  const handler = createRaidChannelMessageHandler({
    GuildConfig: {},
    RAID_REQUIREMENT_MAP: {},
    UI: { icons: { info: "i" } },
    applyRaidSetBatchForDiscordId: null,
    applyRaidSetForDiscordId: async () => ({}),
    buildRaidChannelReceiptEmbed: () => ({}),
    checkUserMonitorCooldown: () => ({ accepted: true }),
    clearPendingHint: async () => {},
    commitUserMonitorActivity: () => {},
    getAccessibleAccounts: async () => [],
    getAnnouncementsConfig: () => ({ whisperAck: { enabled: true } }),
    getCachedMonitorChannelId: () => "channel-1",
    getGatesForRaid: () => [],
    getRaidLabel: (raidKey) => raidKey,
    getUserLanguage: async () => "vi",
    hintKey: () => "hint-key",
    parseRaidMessage: () => {
      calls.parses += 1;
      return null;
    },
    postEmptyContentWarning: async () => {
      calls.emptyWarnings += 1;
    },
    postPersistentHint: async () => {},
    postSpamWarning: async () => {
      calls.spamWarnings += 1;
    },
    t: (key) => key,
    UserModel: {},
    ...overrides,
  });
  return { handler, calls };
}

function makeMessage(overrides = {}) {
  return {
    id: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    content: "hello",
    author: {
      id: "user-1",
      bot: false,
      send: async () => {},
    },
    channel: {
      send: async () => ({ delete: async () => {} }),
    },
    delete: async () => {},
    ...overrides,
  };
}

test("raid-channel message handler ignores messages outside the configured monitor channel", async () => {
  const { handler, calls } = makeHandler();

  await handler.handleRaidChannelMessage(makeMessage({ channelId: "other-channel" }));

  assert.equal(calls.parses, 0);
  assert.equal(calls.emptyWarnings, 0);
});

test("raid-channel message handler warns on empty monitor messages before parsing", async () => {
  const { handler, calls } = makeHandler();

  await handler.handleRaidChannelMessage(makeMessage({ content: "  " }));

  assert.equal(calls.emptyWarnings, 1);
  assert.equal(calls.parses, 0);
});

test("raid-channel message handler claims one Discord message across runtime instances", async () => {
  const claimedMessageIds = new Set();
  let parseCalls = 0;
  const GuildConfig = {
    updateOne: async (filter, update) => {
      const messageId = update.$push.recentRaidMessageIds.$each[0];
      assert.deepEqual(filter, {
        guildId: "guild-1",
        recentRaidMessageIds: { $ne: messageId },
      });
      assert.equal(
        update.$push.recentRaidMessageIds.$slice,
        -MESSAGE_DEDUP_MAX_PERSISTED_IDS
      );

      if (claimedMessageIds.has(messageId)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      claimedMessageIds.add(messageId);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const overrides = {
    GuildConfig,
    parseRaidMessage: () => {
      parseCalls += 1;
      return null;
    },
  };
  const firstRuntime = makeHandler(overrides).handler;
  const secondRuntime = makeHandler(overrides).handler;

  await Promise.all([
    firstRuntime.handleRaidChannelMessage(makeMessage()),
    secondRuntime.handleRaidChannelMessage(makeMessage()),
  ]);

  assert.equal(parseCalls, 1);
  assert.deepEqual([...claimedMessageIds], ["message-1"]);
});

test("raid-channel message handler carries reset intent through write and DM rendering", async () => {
  const writes = [];
  const rendered = [];
  const publicMessages = [];
  const { handler } = makeHandler({
    GuildConfig: {
      findOne: () => ({
        select: () => ({
          lean: async () => ({ announcements: { whisperAck: { enabled: false } } }),
        }),
      }),
    },
    RAID_REQUIREMENT_MAP: {
      armoche_normal: {
        raidKey: "armoche",
        modeKey: "normal",
        label: "Act 4 Normal",
        minItemLevel: 1700,
      },
    },
    getRaidLabel: () => "Act 4",
    getAccessibleAccounts: async () => [{
      ownerDiscordId: "user-1",
      accountName: "Main",
      isOwn: true,
      accessLevel: "edit",
      account: { characters: [{ charName: "Qiylyn" }] },
    }],
    parseRaidMessage: () => ({
      raidKey: "armoche",
      modeKey: null,
      action: "reset",
      charNames: ["qiylyn"],
      gate: null,
    }),
    applyRaidSetForDiscordId: async (args) => {
      writes.push(args);
      return { matched: true, updated: true, displayName: "Qiylyn" };
    },
    buildRaidChannelReceiptEmbed: (args) => {
      rendered.push(args);
      return { data: { title: "reset" } };
    },
  });

  await handler.handleRaidChannelMessage(makeMessage({
    guild: { name: "Raid Guild" },
    content: "act4 rs Qiylyn",
    author: {
      id: "user-1",
      bot: false,
      send: async () => {
        throw new Error("DMs disabled");
      },
    },
    channel: {
      send: async (payload) => {
        publicMessages.push(payload);
        return { delete: async () => {} };
      },
    },
  }));

  assert.equal(writes.length, 1);
  assert.equal(writes[0].statusType, "reset");
  assert.deepEqual(writes[0].effectiveGates, []);
  assert.equal(writes[0].raidMeta.label, "Act 4");
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].resultGroups[0].statusType, "reset");
  assert.equal(publicMessages.length, 1);
  assert.match(publicMessages[0].content, /đã reset \*\*Qiylyn\*\* · Act 4/);
});

test("raid-channel message handler still clears the pending hint when the whisper confirmation fails", async () => {
  const clearedHints = [];
  const { handler } = makeHandler({
    GuildConfig: {
      findOne: () => ({
        select: () => ({
          lean: async () => ({ announcements: { whisperAck: { enabled: true } } }),
        }),
      }),
    },
    RAID_REQUIREMENT_MAP: {
      armoche_normal: {
        raidKey: "armoche",
        modeKey: "normal",
        label: "Act 4 Normal",
        minItemLevel: 1700,
      },
    },
    getRaidLabel: () => "Act 4",
    getAccessibleAccounts: async () => [{
      ownerDiscordId: "user-1",
      accountName: "Main",
      isOwn: true,
      accessLevel: "edit",
      account: { characters: [{ charName: "Qiylyn" }] },
    }],
    parseRaidMessage: () => ({
      raidKey: "armoche",
      modeKey: null,
      action: "reset",
      charNames: ["qiylyn"],
      gate: null,
    }),
    applyRaidSetForDiscordId: async () => ({ matched: true, updated: true, displayName: "Qiylyn" }),
    clearPendingHint: async (_channel, key) => {
      clearedHints.push(key);
    },
  });

  await handler.handleRaidChannelMessage(makeMessage({
    content: "act4 rs Qiylyn",
    channel: {
      send: async () => {
        throw new Error("Missing Permissions");
      },
    },
  }));

  assert.deepEqual(clearedHints, ["hint-key"]);
});

test("raid-channel message handler rejects all writes when any character is unknown", async () => {
  let writeCalls = 0;
  const hints = [];
  const { handler } = makeHandler({
    RAID_REQUIREMENT_MAP: {
      armoche_hard: { raidKey: "armoche", modeKey: "hard", label: "Act 4 Hard", minItemLevel: 0 },
      kazeros_hard: { raidKey: "kazeros", modeKey: "hard", label: "Kazeros Hard", minItemLevel: 0 },
    },
    UI: { icons: { info: "i", warn: "warn" } },
    parseRaidMessage: () => ({
      raidKeys: ["armoche", "kazeros"],
      modeKey: "hard",
      charNames: ["abc1", "missing"],
      gate: null,
    }),
    getAccessibleAccounts: async () => [{
      ownerDiscordId: "user-1",
      accountName: "Main",
      isOwn: true,
      accessLevel: "edit",
      account: { characters: [{ charName: "abc1" }] },
    }],
    applyRaidSetForDiscordId: async () => {
      writeCalls += 1;
      return { matched: true, updated: true };
    },
    applyRaidSetBatchForDiscordId: async () => {
      writeCalls += 1;
      return [];
    },
    postPersistentHint: async (_message, content) => hints.push(content),
  });

  await handler.handleRaidChannelMessage(makeMessage({
    content: "act4 kazeros hm abc1 missing",
  }));

  assert.equal(writeCalls, 0);
  assert.deepEqual(hints, ["text-parser.errorNotFound\ntext-parser.errorRetryNote"]);
});

test("raid-channel message handler fails closed when character preflight cannot load", async () => {
  let writeCalls = 0;
  const hints = [];
  const { handler } = makeHandler({
    RAID_REQUIREMENT_MAP: {
      armoche_hard: { raidKey: "armoche", modeKey: "hard", label: "Act 4 Hard", minItemLevel: 0 },
    },
    UI: { icons: { info: "i", warn: "warn" } },
    parseRaidMessage: () => ({
      raidKeys: ["armoche"],
      modeKey: "hard",
      charNames: ["abc1"],
      gate: null,
    }),
    getAccessibleAccounts: async () => {
      throw new Error("mongo unavailable");
    },
    applyRaidSetForDiscordId: async () => {
      writeCalls += 1;
      return { matched: true, updated: true };
    },
    postPersistentHint: async (_message, content) => hints.push(content),
  });

  await handler.handleRaidChannelMessage(makeMessage({ content: "act4 hm abc1" }));

  assert.equal(writeCalls, 0);
  assert.deepEqual(hints, ["text-parser.errorSystem\ntext-parser.errorRetryNote"]);
});

test("raid-channel message handler batches every raid-character pair and DMs one receipt", async () => {
  const batchCalls = [];
  const dmPayloads = [];
  const rendered = [];
  let accessReads = 0;
  const rosterAfterWrite = [{ ownerDiscordId: "user-1", accountName: "Main", isOwn: true, accessLevel: "edit", account: { characters: [{ charName: "abc1" }, { charName: "abc2" }] } }];
  const { handler } = makeHandler({
    GuildConfig: {
      findOne: () => ({
        select: () => ({
          lean: async () => ({ announcements: { whisperAck: { enabled: false } } }),
        }),
      }),
    },
    RAID_REQUIREMENT_MAP: {
      armoche_hard: { raidKey: "armoche", modeKey: "hard", label: "Act 4 Hard", minItemLevel: 0 },
      kazeros_hard: { raidKey: "kazeros", modeKey: "hard", label: "Kazeros Hard", minItemLevel: 0 },
    },
    parseRaidMessage: () => ({
      raidKeys: ["armoche", "kazeros"],
      raidDisplayNames: { kazeros: "Final" },
      modeKey: "hard",
      charNames: ["abc1", "abc2"],
      gate: null,
    }),
    getAccessibleAccounts: async () => {
      accessReads += 1;
      return accessReads === 1
        ? [{ ownerDiscordId: "user-1", accountName: "Main", isOwn: true, accessLevel: "edit", account: { characters: [{ charName: "abc1" }, { charName: "abc2" }] } }]
        : rosterAfterWrite;
    },
    applyRaidSetBatchForDiscordId: async (args) => {
      batchCalls.push(args);
      return args.entries.map((entry) => ({
        matched: true,
        updated: true,
        displayName: entry.characterName,
      }));
    },
    buildRaidChannelReceiptEmbed: (args) => {
      rendered.push(args);
      return { data: { title: "receipt" } };
    },
  });

  await handler.handleRaidChannelMessage(makeMessage({
    content: "act4 final hm abc1 abc2",
    author: {
      id: "user-1",
      bot: false,
      send: async (payload) => dmPayloads.push(payload),
    },
  }));

  assert.equal(batchCalls.length, 1);
  assert.deepEqual(
    batchCalls[0].entries.map((entry) => `${entry.characterName}:${entry.raidMeta.raidKey}`),
    ["abc1:armoche", "abc1:kazeros", "abc2:armoche", "abc2:kazeros"]
  );
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].text, "act4 final hm abc1 abc2");
  assert.deepEqual(rendered[0].resultGroups.map((group) => group.raidMeta.label), ["Act 4 Hard", "Final Hard"]);
  assert.equal(rendered[0].accounts, rosterAfterWrite);
  assert.equal(rendered[0].afterWrite, true);
  assert.equal(accessReads, 2);
  assert.equal(dmPayloads.length, 1);
  assert.equal(dmPayloads[0].embeds.length, 1);
});

test("raid-channel message handler still sends the receipt when the re-read fails", async () => {
  const rendered = [];
  const dmPayloads = [];
  const rosterBeforeWrite = [{ ownerDiscordId: "user-1", accountName: "Main", isOwn: true, accessLevel: "edit", account: { characters: [{ charName: "abc1" }] } }];
  let accessReads = 0;
  const { handler } = makeHandler({
    GuildConfig: {
      findOne: () => ({
        select: () => ({
          lean: async () => ({ announcements: { whisperAck: { enabled: false } } }),
        }),
      }),
    },
    RAID_REQUIREMENT_MAP: {
      armoche_hard: { raidKey: "armoche", modeKey: "hard", label: "Act 4 Hard", minItemLevel: 0 },
    },
    parseRaidMessage: () => ({ raidKeys: ["armoche"], modeKey: "hard", charNames: ["abc1"], gate: null }),
    getAccessibleAccounts: async () => {
      accessReads += 1;
      if (accessReads > 1) throw new Error("mongo unavailable");
      return rosterBeforeWrite;
    },
    applyRaidSetForDiscordId: async () => ({ matched: true, updated: true, displayName: "abc1" }),
    buildRaidChannelReceiptEmbed: (args) => {
      rendered.push(args);
      return { data: { title: "receipt" } };
    },
  });

  await handler.handleRaidChannelMessage(makeMessage({
    content: "act4 hm abc1",
    author: { id: "user-1", bot: false, send: async (payload) => dmPayloads.push(payload) },
  }));

  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].accounts, rosterBeforeWrite);
  assert.equal(rendered[0].afterWrite, false);
  assert.equal(dmPayloads.length, 1);
});

test("raid-channel message handler posts one fallback and one hint for a multi-raid post", async () => {
  const publicMessages = [];
  const hints = [];
  const { handler } = makeHandler({
    UI,
    GuildConfig: {
      findOne: () => ({
        select: () => ({
          lean: async () => ({ announcements: { whisperAck: { enabled: false } } }),
        }),
      }),
    },
    RAID_REQUIREMENT_MAP: {
      armoche_hard: { raidKey: "armoche", modeKey: "hard", label: "Act 4 Hard", minItemLevel: 1720 },
      kazeros_hard: { raidKey: "kazeros", modeKey: "hard", label: "Kazeros Hard", minItemLevel: 1730 },
    },
    parseRaidMessage: () => ({
      raidKeys: ["armoche", "kazeros"],
      modeKey: "hard",
      charNames: ["abc1", "abc2"],
      gate: null,
    }),
    getAccessibleAccounts: async () => [{
      ownerDiscordId: "user-1",
      accountName: "Main",
      isOwn: true,
      accessLevel: "edit",
      account: { characters: [{ charName: "abc1" }, { charName: "abc2" }] },
    }],
    applyRaidSetBatchForDiscordId: async (args) => args.entries.map((entry) => (
      entry.characterName === "abc2"
        ? { matched: true, updated: false, ineligibleItemLevel: 1725, displayName: "abc2" }
        : { matched: true, updated: true, displayName: "abc1" }
    )),
    postPersistentHint: async (_message, content) => hints.push(content),
  });

  await handler.handleRaidChannelMessage(makeMessage({
    content: "act4 kazeros hm abc1 abc2",
    author: {
      id: "user-1",
      bot: false,
      send: async () => {
        throw new Error("DMs disabled");
      },
    },
    channel: {
      send: async (payload) => {
        publicMessages.push(payload);
        return { delete: async () => {} };
      },
    },
  }));

  assert.equal(publicMessages.length, 1);
  assert.match(publicMessages[0].content, /^🟢 <@user-1> đã ghi \*\*abc1\*\* · Act 4 Hard, Kazeros Hard\. /);
  assert.equal(hints.length, 1);
  assert.deepEqual(hints[0].split("\n"), [
    "⚠️ Chưa đủ iLvl: **abc2** (iLvl 1725) · Act 4 Hard (cần 1720+), Kazeros Hard (cần 1730+)",
    "_(Các character hợp lệ khác trong post của bạn đã được update rồi - check DM cho chi tiết.)_",
  ]);
});
