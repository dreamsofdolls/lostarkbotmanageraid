"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidChannelHintService,
} = require("../bot/services/raid/channel-monitor/channel-monitor-hints");

function createHarness() {
  let currentTime = 1_000_000;
  const replies = [];
  const deletedMessages = [];
  const clearedTimers = [];
  let timerSeq = 0;
  const channel = {
    messages: {
      fetch: async (id) => ({
        id,
        delete: async () => {
          deletedMessages.push(id);
        },
      }),
    },
  };
  const service = createRaidChannelHintService({
    UI: { icons: { warn: "[warn]" } },
    UserModel: {},
    normalizeName: (value) => String(value || "").trim().toLowerCase(),
    getUserLanguage: async () => "en",
    t: (key, lang, vars = {}) =>
      [key, lang, vars.icon, vars.userId].filter(Boolean).join("|"),
    now: () => currentTime,
    setTimeoutFn: () => {
      timerSeq += 1;
      return `timer-${timerSeq}`;
    },
    clearTimeoutFn: (timerId) => {
      clearedTimers.push(timerId);
    },
  });

  function createMessage(overrides = {}) {
    return {
      id: overrides.id || `msg-${replies.length + 1}`,
      guildId: "guild-1",
      channelId: "channel-1",
      channel,
      content: overrides.content || "qiylyn act4 g1",
      author: {
        id: "user-1",
      },
      reply: async (payload) => {
        replies.push(payload);
        return {
          id: `hint-${replies.length}`,
          delete: async () => {
            deletedMessages.push(`hint-${replies.length}`);
          },
        };
      },
    };
  }

  return {
    service,
    replies,
    deletedMessages,
    clearedTimers,
    advance(ms) {
      currentTime += ms;
    },
    createMessage,
  };
}

test("raid-channel hint service throttles empty-content warnings per channel", async () => {
  const harness = createHarness();
  const message = harness.createMessage({ content: "" });

  await harness.service.postEmptyContentWarning(message);
  await harness.service.postEmptyContentWarning(message);

  assert.equal(harness.replies.length, 1);
  assert.match(harness.replies[0].content, /text-parser\.emptyContent/);

  harness.advance(5 * 60 * 1000 + 1);
  await harness.service.postEmptyContentWarning(message);

  assert.equal(harness.replies.length, 2);
});

test("raid-channel hint service allows one quick correction while a hint is pending", async () => {
  const harness = createHarness();
  const first = harness.createMessage({ id: "msg-a", content: "qiylyn act4 typo" });

  assert.deepEqual(harness.service.checkUserMonitorCooldown(first), {
    accepted: true,
    warn: false,
    viaException: false,
  });
  harness.service.commitUserMonitorActivity(first);

  const duplicate = harness.createMessage({ id: "msg-b", content: "qiylyn act4 typo" });
  assert.deepEqual(harness.service.checkUserMonitorCooldown(duplicate), {
    accepted: false,
    warn: false,
    viaException: false,
  });

  await harness.service.postPersistentHint(first, "try again");
  const correction = harness.createMessage({ id: "msg-c", content: "qiylyn act4 g1" });
  assert.deepEqual(harness.service.checkUserMonitorCooldown(correction), {
    accepted: true,
    warn: false,
    viaException: true,
  });
  harness.service.commitUserMonitorActivity(correction, true);

  const secondCorrection = harness.createMessage({
    id: "msg-d",
    content: "qiylyn act4 g2",
  });
  assert.deepEqual(harness.service.checkUserMonitorCooldown(secondCorrection), {
    accepted: false,
    warn: false,
    viaException: false,
  });
});

test("raid-channel hint service clears both bot hint and original failed message", async () => {
  const harness = createHarness();
  const message = harness.createMessage({ id: "original-1" });
  const key = harness.service.hintKey(
    message.guildId,
    message.channelId,
    message.author.id
  );

  await harness.service.postPersistentHint(message, "bad input");
  await harness.service.clearPendingHint(message.channel, key);

  assert.deepEqual(harness.deletedMessages.sort(), ["hint-1", "original-1"]);
  assert.deepEqual(harness.clearedTimers, ["timer-1"]);
});
