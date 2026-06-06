const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createScheduleCancelActions,
} = require("../bot/handlers/raid/schedule/actions/cancel-actions");

function makeEvent(overrides = {}) {
  return {
    _id: "event-1",
    guildId: "guild-1",
    channelId: "channel-1",
    title: "Act 4",
    status: "open",
    signups: [
      { discordId: "u1" },
      { discordId: "u2" },
      { discordId: "u1" },
    ],
    skipNotify: false,
    saved: 0,
    async save() {
      this.saved += 1;
    },
    ...overrides,
  };
}

function makeInteraction(channel) {
  const edits = [];
  return {
    edits,
    deferred: 0,
    client: {
      channels: {
        fetch: async () => channel,
      },
    },
    async deferUpdate() {
      this.deferred += 1;
    },
    async editReply(payload) {
      edits.push(payload);
      return {};
    },
  };
}

function makeActions({ editCalls = [] } = {}) {
  return createScheduleCancelActions({
    boardLang: async (guildId) => `board-${guildId}`,
    editBoardMessage: async (interaction, event, lang) => {
      editCalls.push({ interaction, event, lang });
    },
    rejectUnlessLeadMutable: async () => false,
    noticeEmbed: (tone, title, description) => ({ tone, title, description }),
    ephemeralFlag: 64,
  });
}

test("schedule cancel marks event cancelled, refreshes board, and pings unique signups", async () => {
  const sent = [];
  const channel = { send: async (payload) => sent.push(payload) };
  const interaction = makeInteraction(channel);
  const event = makeEvent();
  const editCalls = [];
  const actions = makeActions({ editCalls });

  await actions.handleCancel(interaction, event, "vi");

  assert.equal(interaction.deferred, 1);
  assert.equal(event.status, "cancelled");
  assert.ok(event.cancelledAt instanceof Date);
  assert.equal(event.saved, 1);
  assert.equal(editCalls[0].lang, "board-guild-1");
  assert.equal(interaction.edits[0].flags, 64);
  assert.equal(interaction.edits[0].components.length, 0);
  assert.equal(interaction.edits[0].embeds[0].tone, "warn");
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /<@u1> <@u2>/);
  assert.doesNotMatch(sent[0].content, /<@u1> <@u2> <@u1>/);
});

test("schedule cancel skips public ping in silent mode", async () => {
  const sent = [];
  const channel = { send: async (payload) => sent.push(payload) };
  const interaction = makeInteraction(channel);
  const event = makeEvent({ skipNotify: true });
  const actions = makeActions();

  await actions.handleCancel(interaction, event, "vi");

  assert.equal(sent.length, 0);
});
