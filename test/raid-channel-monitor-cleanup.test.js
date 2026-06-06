"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanupRaidChannelMessages,
  resolveRaidMonitorChannel,
} = require("../bot/services/raid/channel-monitor/channel-monitor-cleanup");

function makeBatch(messages) {
  return {
    size: messages.length,
    last: () => messages[messages.length - 1] || null,
    filter(predicate) {
      return makeBatch(messages.filter(predicate));
    },
    map(fn) {
      return messages.map(fn);
    },
  };
}

test("raid-channel cleanup paginates, skips pinned messages, and counts old-message skips", async () => {
  const fetches = [];
  const bulkDeletes = [];
  const pinnedMessages = Array.from({ length: 98 }, (_, index) => ({
    id: `pinned-${index}`,
    pinned: true,
  }));
  const batches = [
    makeBatch([{ id: "3", pinned: false }, ...pinnedMessages, { id: "1", pinned: false }]),
    makeBatch([{ id: "0", pinned: false }]),
  ];
  const channel = {
    messages: {
      fetch: async (opts) => {
        fetches.push(opts);
        return batches.shift() || makeBatch([]);
      },
    },
    bulkDelete: async (collection) => {
      bulkDeletes.push(collection.map((message) => message.id));
      return { size: Math.max(0, collection.size - 1) };
    },
  };

  const report = await cleanupRaidChannelMessages(channel);

  assert.deepEqual(fetches, [{ limit: 100 }, { limit: 100, before: "1" }]);
  assert.deepEqual(bulkDeletes, [["3", "1"], ["0"]]);
  assert.deepEqual(report, { deleted: 1, skippedOld: 2 });
});

test("raid-channel monitor channel resolver falls back to guild fetch", async () => {
  const fetchedChannel = { id: "channel-1" };
  const interaction = {
    guild: {
      channels: {
        cache: new Map(),
        fetch: async (channelId) => {
          assert.equal(channelId, "channel-1");
          return fetchedChannel;
        },
      },
    },
  };

  assert.equal(await resolveRaidMonitorChannel(interaction, "channel-1"), fetchedChannel);
});
