"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require("discord.js");

const { UI } = require("../bot/utils/raid/common/shared");
const {
  createRaidScheduleAutoLockService,
} = require("../bot/services/raid/schedule/lifecycle/auto-lock");
const { createRaidScheduleCommand } = require("../bot/handlers/raid/schedule");

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

test("auto-lock keeps the lead's board switcher when it refreshes the board", async () => {
  const due = makeEvent();
  const other = makeEvent({ _id: "abcdef654321", messageId: "m2", startAt: new Date(Date.UTC(2026, 4, 30, 13, 0)) });
  const boards = [due, other];
  let editedPayload = null;

  // Serves both the tick's due-event scan (find().limit()) and the board
  // payload's owned-board lookup (find().sort().lean()).
  const RaidEvent = {
    find: (query) => {
      const hits = query.autoLockAtStart ? [due] : boards.filter((b) => query.status.$in.includes(b.status));
      return {
        limit: async () => hits,
        sort() { return this; },
        lean: async () => hits,
      };
    },
    findOneAndUpdate: async () => {
      due.status = "locked";
      return due;
    },
  };
  const GuildConfig = { findOne: () => ({ lean: async () => null }) };
  const { boardPayload } = createRaidScheduleCommand({
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
    UI, User: {}, GuildConfig, RaidEvent,
    isManagerId: () => true,
    applyRaidSetBatchForDiscordId: async () => [],
  });
  const client = {
    channels: {
      fetch: async () => ({
        messages: { fetch: async () => ({ edit: async (payload) => { editedPayload = payload; } }) },
      }),
    },
  };

  const service = createRaidScheduleAutoLockService({
    RaidEvent,
    GuildConfig,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
    boardPayload,
  });
  await service.runRaidScheduleAutoLockTick(client, new Date(Date.UTC(2026, 4, 29, 13, 1)));

  assert.ok(editedPayload);
  const customIds = editedPayload.components.map((row) => row.components[0].data.custom_id);
  assert.equal(editedPayload.components.length, 3);
  assert.equal(customIds[2], "rse:showpick:abcdef123456");
  assert.equal(editedPayload.components[0].components[0].data.disabled, true);
});

function autoLockRetryHarness({ lockedNow }) {
  const due = makeEvent();
  const locked = makeEvent({ status: "locked" });
  let openEvents = [due];
  const edits = [];
  const RaidEvent = {
    find: () => ({ limit: async () => openEvents }),
    findOneAndUpdate: async () => {
      openEvents = [];
      return locked;
    },
    findOne: async (filter) => {
      assert.deepEqual(filter, { _id: locked._id, status: "locked" });
      return lockedNow() ? locked : null;
    },
  };
  const client = {
    channels: {
      fetch: async () => ({
        messages: {
          fetch: async () => ({
            edit: async (payload) => {
              edits.push(payload);
              if (edits.length === 1) throw Object.assign(new Error("Service Unavailable"), { status: 503 });
            },
          }),
        },
      }),
    },
  };
  const service = createRaidScheduleAutoLockService({
    RaidEvent, GuildConfig: null, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, UI,
  });
  const tick = () => service.runRaidScheduleAutoLockTick(client, new Date(Date.UTC(2026, 4, 29, 13, 1)));
  return { edits, tick };
}

test("auto-lock retries a board edit that failed after its event locked", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { edits, tick } = autoLockRetryHarness({ lockedNow: () => true });

  await tick();
  await tick();
  await tick();

  assert.equal(edits.length, 2);
  const joinButton = edits[1].components[0].components.find(
    (component) => component.data.custom_id === "rse:join:abcdef123456",
  );
  assert.equal(joinButton.data.disabled, true);
});

test("auto-lock drops a board retry once its event is no longer locked", async (t) => {
  t.mock.method(console, "warn", () => {});
  let stillLocked = true;
  const { edits, tick } = autoLockRetryHarness({ lockedNow: () => stillLocked });

  await tick();
  stillLocked = false;
  await tick();
  await tick();

  assert.equal(edits.length, 1);
});

test("auto-lock scheduler skips an interval while the previous tick is running", async () => {
  const originalSetInterval = global.setInterval;
  const originalWarn = console.warn;
  let intervalFn = null;
  let releaseFirstTick = null;
  let findCalls = 0;
  const firstTick = new Promise((resolve) => {
    releaseFirstTick = resolve;
  });
  const RaidEvent = {
    find() {
      return {
        limit() {
          findCalls += 1;
          return findCalls === 1 ? firstTick : Promise.resolve([]);
        },
      };
    },
  };
  global.setInterval = (fn) => {
    intervalFn = fn;
    return { unref() {} };
  };
  console.warn = () => {};

  try {
    const service = createRaidScheduleAutoLockService({
      RaidEvent,
      GuildConfig: null,
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      UI,
    });
    service.startRaidScheduleAutoLockScheduler({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(findCalls, 1);

    await intervalFn();
    assert.equal(findCalls, 1);

    releaseFirstTick([]);
    await new Promise((resolve) => setImmediate(resolve));
    await intervalFn();
    assert.equal(findCalls, 2);
  } finally {
    global.setInterval = originalSetInterval;
    console.warn = originalWarn;
    releaseFirstTick([]);
  }
});
