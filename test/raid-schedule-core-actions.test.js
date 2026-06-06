"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createScheduleCoreActions,
} = require("../bot/handlers/raid/schedule/actions/core-actions");

function makeEvent(overrides = {}) {
  return {
    _id: "event-1",
    guildId: "guild-1",
    raidKey: "armoche",
    modeKey: "hard",
    messageId: "message-1",
    skipNotify: false,
    status: "open",
    saved: 0,
    async save() {
      this.saved += 1;
    },
    ...overrides,
  };
}

function makeActions(overrides = {}) {
  const calls = {
    boardPayloads: [],
    boardEdits: [],
    notices: [],
    replies: [],
    editReplies: [],
    followUps: [],
  };
  const actions = createScheduleCoreActions({
    RaidEvent: overrides.RaidEvent || class {},
    ephemeralFlag: 64,
    userLang: async () => "vi",
    boardLang: async (guildId) => `board-${guildId}`,
    boardPayload: async (event, lang) => {
      calls.boardPayloads.push({ event, lang });
      return { embeds: [{ board: lang }], components: [{ board: true }] };
    },
    editBoardMessage: async (interaction, event, lang) => {
      calls.boardEdits.push({ interaction, event, lang });
      return true;
    },
    isCompMember: overrides.isCompMember || (() => true),
    onBoardMessage: overrides.onBoardMessage || (() => false),
    raidMetaFor: () => ({ label: "Act 4 Hard", minItemLevel: 1700 }),
    rejectUnlessLead: async () => false,
    rejectUnlessLeadMutable: overrides.rejectUnlessLeadMutable || (async () => false),
    writeAutoClears: overrides.writeAutoClears || (async () => ({ targets: 0, updated: 0, failed: 0 })),
    manageMenuPayload: (event, lang) => ({ embeds: [{ menu: lang, skipNotify: event.skipNotify }], components: [] }),
    noticeEmbed: (tone, title, description) => ({ tone, title, description }),
    replyNotice: async (...args) => calls.notices.push(args),
  });
  return { actions, calls };
}

function makeInteraction(overrides = {}) {
  const interaction = {
    user: { id: "user-1" },
    deferred: 0,
    replies: [],
    editReplies: [],
    followUps: [],
    async deferUpdate() {
      this.deferred += 1;
    },
    async reply(payload) {
      this.replies.push(payload);
    },
    async editReply(payload) {
      this.editReplies.push(payload);
    },
    async followUp(payload) {
      this.followUps.push(payload);
    },
    ...overrides,
  };
  return interaction;
}

test("schedule core room action denies non-comp members before exposing room info", async () => {
  const { actions, calls } = makeActions({ isCompMember: () => false });
  const interaction = makeInteraction();

  await actions.handleRoom(interaction, makeEvent({ roomName: "Bckg" }), "vi");

  assert.equal(calls.notices.length, 1);
  assert.equal(calls.notices[0][2], "warn");
  assert.equal(calls.notices[0][3], "roomDeniedTitle");
  assert.equal(interaction.replies.length, 0);
});

test("schedule core notify action flips silent mode and re-renders manage menu", async () => {
  const { actions } = makeActions();
  const interaction = makeInteraction();
  const event = makeEvent({ skipNotify: false });

  await actions.handleToggleNotify(interaction, event, "vi");

  assert.equal(interaction.deferred, 1);
  assert.equal(event.skipNotify, true);
  assert.equal(event.saved, 1);
  assert.deepEqual(interaction.editReplies[0], {
    embeds: [{ menu: "vi", skipNotify: true }],
    components: [],
  });
});

test("schedule core end action writes clears, freezes event, and updates manage surface", async () => {
  const { actions, calls } = makeActions({
    writeAutoClears: async () => ({ targets: 2, updated: 1, failed: 1 }),
    onBoardMessage: () => false,
  });
  const interaction = makeInteraction();
  const event = makeEvent();

  await actions.handleEnd(interaction, event, "vi");

  assert.equal(interaction.deferred, 1);
  assert.equal(event.status, "cleared");
  assert.ok(event.clearedAt instanceof Date);
  assert.equal(event.saved, 1);
  assert.equal(calls.boardEdits.length, 1);
  assert.equal(calls.boardEdits[0].lang, "board-guild-1");
  assert.equal(interaction.editReplies[0].components.length, 0);
  assert.equal(interaction.editReplies[0].embeds[0].tone, "warn");
});
