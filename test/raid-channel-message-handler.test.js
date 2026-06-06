"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidChannelMessageHandler,
} = require("../bot/services/raid/channel-monitor/channel-monitor-message-handler");

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
    buildRaidChannelMultiResultEmbed: () => ({}),
    checkUserMonitorCooldown: () => ({ accepted: true }),
    clearPendingHint: async () => {},
    commitUserMonitorActivity: () => {},
    getAccessibleAccounts: async () => [],
    getAnnouncementsConfig: () => ({ whisperAck: { enabled: true } }),
    getCachedMonitorChannelId: () => "channel-1",
    getGatesForRaid: () => [],
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
