"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidChannelResetService,
} = require("../bot/services/raid/channel-monitor/channel-monitor-reset");

test("raid-channel reset cleans first and finishes by posting a fresh welcome pin", async () => {
  const events = [];
  const channel = { id: "channel-1" };
  const client = { user: { id: "bot" } };
  const service = createRaidChannelResetService({
    cleanupRaidChannelMessages: async (target, options) => {
      events.push("cleanup");
      assert.equal(target, channel);
      assert.deepEqual(options, { protectedMessageIds: ["old-welcome"] });
      return { deleted: 12, skippedOld: 1 };
    },
    postRaidChannelWelcome: async (target, botUserId, guildId, options) => {
      events.push("welcome");
      assert.equal(target, channel);
      assert.equal(botUserId, "bot");
      assert.equal(guildId, "guild-1");
      assert.deepEqual(options, { client });
      return { posted: true, pinned: true, persisted: true, removedOldCount: 1 };
    },
  });

  const outcome = await service.cleanupAndRefreshRaidChannel(channel, {
    botUserId: "bot",
    client,
    guildId: "guild-1",
    protectedMessageIds: ["old-welcome"],
  });

  assert.deepEqual(events, ["cleanup", "welcome"]);
  assert.equal(outcome.deleted, 12);
  assert.equal(outcome.welcome.pinned, true);
  assert.equal(outcome.welcome.persisted, true);
});

test("raid-channel reset fails the cycle when the replacement welcome is not durable", async () => {
  const cleanup = { deleted: 5, skippedOld: 0 };
  const welcome = { posted: true, pinned: false, persisted: false, removedOldCount: 0 };
  const service = createRaidChannelResetService({
    cleanupRaidChannelMessages: async () => cleanup,
    postRaidChannelWelcome: async () => welcome,
  });

  await assert.rejects(
    service.cleanupAndRefreshRaidChannel({ id: "channel-1" }, {
      botUserId: "bot",
      guildId: "guild-1",
    }),
    (err) => {
      assert.equal(err.code, "RAID_CHANNEL_WELCOME_REFRESH_FAILED");
      assert.equal(err.cleanup, cleanup);
      assert.equal(err.welcome, welcome);
      return true;
    }
  );
});
