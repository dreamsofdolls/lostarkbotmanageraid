"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const { UI } = require("../bot/utils/raid/common/shared");
const {
  createRaidScheduleAutoLockService,
} = require("../bot/services/raid/schedule/lifecycle/auto-lock");

function makeEvent(extra = {}) {
  return {
    _id: "abcdef123456",
    guildId: "g1",
    channelId: "c1",
    messageId: "m1",
    creatorId: "lead1",
    raidKey: "armoche",
    modeKey: "hard",
    minItemLevel: 1720,
    partySize: 4,
    supSlots: 1,
    dpsSlots: 3,
    title: "Tonight",
    startAt: new Date(Date.UTC(2026, 4, 29, 13, 0)),
    autoLockAtStart: true,
    status: "open",
    signups: [],
    ...extra,
  };
}

test("auto-lock tick flips due open events and refreshes the board", async () => {
  const original = makeEvent();
  const updated = makeEvent({ status: "locked" });
  let editedPayload = null;

  const RaidEvent = {
    find(query) {
      assert.equal(query.status, "open");
      assert.equal(query.autoLockAtStart, true);
      assert.ok(query.startAt.$lte instanceof Date);
      return {
        limit: async () => [original],
      };
    },
    findOneAndUpdate: async (filter, update, options) => {
      assert.equal(filter._id, original._id);
      assert.equal(filter.status, "open");
      assert.equal(update.$set.status, "locked");
      assert.equal(options.new, true);
      return updated;
    },
  };
  const client = {
    channels: {
      fetch: async (channelId) => {
        assert.equal(channelId, "c1");
        return {
          messages: {
            fetch: async (messageId) => {
              assert.equal(messageId, "m1");
              return {
                edit: async (payload) => {
                  editedPayload = payload;
                },
              };
            },
          },
        };
      },
    },
  };

  const service = createRaidScheduleAutoLockService({
    RaidEvent,
    GuildConfig: null,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
  });
  const result = await service.runRaidScheduleAutoLockTick(
    client,
    new Date(Date.UTC(2026, 4, 29, 13, 1)),
  );

  assert.deepEqual(result, { scanned: 1, locked: 1 });
  assert.ok(editedPayload);
  const joinButton = editedPayload.components[0].components.find(
    (component) => component.data.custom_id === "rse:join:abcdef123456",
  );
  assert.equal(joinButton.data.disabled, true);
});
