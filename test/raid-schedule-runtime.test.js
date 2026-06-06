"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createScheduleRuntimeHelpers,
} = require("../bot/handlers/raid/schedule/runtime");

function makeRaidEventModel({ owned = [], findByIdResult = null } = {}) {
  return {
    find(query) {
      return {
        sort(sortSpec) {
          return {
            lean: async () => {
              owned.query = query;
              owned.sortSpec = sortSpec;
              return owned;
            },
          };
        },
      };
    },
    findById: async (id) => (String(id) === "event-1" ? findByIdResult : null),
  };
}

function makeRuntime(overrides = {}) {
  const notices = [];
  let componentArgs = null;
  const runtime = createScheduleRuntimeHelpers({
    ActionRowBuilder: class {},
    ButtonBuilder: class {},
    ButtonStyle: {},
    StringSelectMenuBuilder: class {},
    EmbedBuilder: class {},
    UI: {},
    User: {},
    GuildConfig: {},
    RaidEvent: makeRaidEventModel(overrides.raidEvents),
    isManagerId: (id) => id === "lead",
    applyRaidSetBatchForDiscordId: overrides.applyRaidSetBatchForDiscordId,
    buildScheduleEmbed: (event, args) => ({ eventId: String(event._id), lang: args.lang }),
    buildScheduleComponents: (event, args) => {
      componentArgs = args;
      return [{ ownedBoardOptions: args.ownedBoardOptions }];
    },
    replyNotice: async (...args) => notices.push(args),
    logger: { warn: () => {} },
  });
  return { runtime, notices, getComponentArgs: () => componentArgs };
}

function makeAutoClearEvent() {
  return {
    _id: "event-1",
    raidKey: "armoche",
    modeKey: "hard",
    supSlots: 1,
    dpsSlots: 1,
    signups: [
      {
        discordId: "user-a",
        accountName: "Roster A",
        characterName: "Support",
        role: "support",
        status: "confirmed",
        joinedAt: 1,
      },
      {
        discordId: "user-a",
        accountName: "Roster A",
        characterName: "Dps",
        role: "dps",
        status: "confirmed",
        joinedAt: 2,
      },
    ],
  };
}

test("schedule runtime boardPayload includes active boards owned by the creator", async () => {
  const owned = [
    {
      _id: "event-1",
      guildId: "guild-1",
      channelId: "channel-1",
      creatorId: "lead",
      raidKey: "armoche",
      modeKey: "hard",
      partySize: 2,
      supSlots: 1,
      dpsSlots: 1,
      startAt: new Date("2026-06-05T10:00:00Z"),
      signups: [],
    },
    {
      _id: "event-2",
      guildId: "guild-1",
      channelId: "channel-1",
      creatorId: "lead",
      raidKey: "kazeros",
      modeKey: "hard",
      partySize: 8,
      supSlots: 2,
      dpsSlots: 6,
      startAt: new Date("2026-06-05T11:00:00Z"),
      signups: [],
    },
  ];
  const { runtime, getComponentArgs } = makeRuntime({ raidEvents: { owned } });

  const payload = await runtime.boardPayload(owned[0], "vi");

  assert.equal(payload.embeds[0].lang, "vi");
  assert.equal(getComponentArgs().ownedBoardOptions.length, 2);
  assert.equal(getComponentArgs().ownedBoardOptions[0].isCurrent, true);
});

test("schedule runtime auto-clear writer groups targets by owner and counts results", async () => {
  const calls = [];
  const { runtime } = makeRuntime({
    applyRaidSetBatchForDiscordId: async (call) => {
      calls.push(call);
      return call.entries.map((entry, index) => ({ updated: index === 0, entry }));
    },
  });

  const result = await runtime.writeAutoClears(
    { user: { id: "lead" } },
    makeAutoClearEvent()
  );

  assert.deepEqual(result, { targets: 2, updated: 1, failed: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].discordId, "user-a");
  assert.deepEqual(
    calls[0].entries.map((entry) => entry.characterName),
    ["Support", "Dps"]
  );
  assert.deepEqual(calls[0].entries[0].effectiveGates, ["G1", "G2"]);
});

test("schedule runtime guards non-leads and closed events", async () => {
  const { runtime, notices } = makeRuntime();

  assert.equal(
    await runtime.rejectUnlessLead({ user: { id: "member" } }, "vi"),
    true
  );
  assert.equal(notices.length, 1);
  assert.equal(runtime.isClosedEvent({ status: "cancelled" }), true);
  assert.equal(runtime.isClosedEvent({ status: "open" }), false);
});
