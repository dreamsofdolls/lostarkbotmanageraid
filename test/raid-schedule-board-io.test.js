"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  editBoardMessage,
  deleteBoardMessage,
  sendToBoardChannel,
} = require("../bot/services/raid/schedule/board-io");

function makeClient({ message = null, channelError = null, sent = [] } = {}) {
  return {
    channels: {
      async fetch() {
        if (channelError) throw channelError;
        return {
          messages: { fetch: async () => message },
          send: async (payload) => { sent.push(payload); },
        };
      },
    },
  };
}

function makeLogger() {
  const warns = [];
  return { warns, warn: (...args) => warns.push(args) };
}

const board = { channelId: "c1", messageId: "m1" };

test("board edit builds the payload only once the message is found", async () => {
  const edits = [];
  let built = 0;
  const buildPayload = async () => { built += 1; return { content: "board" }; };
  const message = { edit: async (payload) => edits.push(payload) };

  assert.equal(await editBoardMessage(makeClient({ message }), board, buildPayload), true);
  assert.deepEqual(edits, [{ content: "board" }]);

  assert.equal(await editBoardMessage(makeClient(), board, buildPayload), false);
  assert.equal(await editBoardMessage(makeClient({ message }), { channelId: "c1" }, buildPayload), false);
  assert.equal(await editBoardMessage({}, board, buildPayload), false);
  assert.equal(built, 1);
});

test("board edit and delete log failures under their label and resolve false", async () => {
  const logger = makeLogger();
  const client = makeClient({ channelError: new Error("Missing Access") });

  assert.equal(await editBoardMessage(client, board, () => ({}), { logger }), false);
  assert.equal(await deleteBoardMessage(client, board, { logLabel: "switch old-delete failed", logger }), false);
  assert.deepEqual(logger.warns, [
    ["[raid-schedule] board edit failed:", "Missing Access"],
    ["[raid-schedule] switch old-delete failed:", "Missing Access"],
  ]);
});

test("board delete reports whether a message was removed; a null label stays silent", async () => {
  let deleted = 0;
  const message = { delete: async () => { deleted += 1; } };
  const logger = makeLogger();

  assert.equal(await deleteBoardMessage(makeClient({ message }), board), true);
  assert.equal(await deleteBoardMessage(makeClient(), board), false);
  assert.equal(
    await deleteBoardMessage(makeClient({ channelError: new Error("gone") }), board, { logLabel: null, logger }),
    false,
  );
  assert.equal(deleted, 1);
  assert.deepEqual(logger.warns, []);
});

test("channel send posts the payload and never throws", async () => {
  const sent = [];
  await sendToBoardChannel(makeClient({ sent }), "c1", { content: "ping" });
  assert.deepEqual(sent, [{ content: "ping" }]);

  const logger = makeLogger();
  await sendToBoardChannel(makeClient({ channelError: new Error("down") }), "c1", {}, {
    logLabel: "cancel ping failed",
    logger,
  });
  await sendToBoardChannel(undefined, "c1", {}, { logLabel: "add-member ping failed", logger });
  assert.equal(logger.warns.length, 2);
  assert.deepEqual(logger.warns[0], ["[raid-schedule] cancel ping failed:", "down"]);
  assert.equal(logger.warns[1][0], "[raid-schedule] add-member ping failed:");
});
