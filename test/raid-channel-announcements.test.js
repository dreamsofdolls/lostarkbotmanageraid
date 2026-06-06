"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  postChannelAnnouncement,
} = require("../bot/services/raid/channel-announcements");

test("postChannelAnnouncement sends content with optional components", async () => {
  const calls = [];
  const sentMessage = { id: "message-1", delete: async () => {} };
  const channel = {
    send: async (payload) => {
      calls.push(payload);
      return sentMessage;
    },
  };

  const result = await postChannelAnnouncement(channel, "hello", 0, "test", ["row"]);

  assert.equal(result, sentMessage);
  assert.deepEqual(calls, [{ content: "hello", components: ["row"] }]);
});

test("postChannelAnnouncement returns null and logs when send fails", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const result = await postChannelAnnouncement(
      { send: async () => { throw new Error("no permission"); } },
      "hello",
      0,
      "raid-channel"
    );

    assert.equal(result, null);
    assert.deepEqual(warnings, [["[raid-channel] send failed:", "no permission"]]);
  } finally {
    console.warn = originalWarn;
  }
});
