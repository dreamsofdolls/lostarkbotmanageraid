const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createScheduleModalActions,
} = require("../bot/handlers/raid/schedule/actions/modal-actions");

class FakeActionRowBuilder {
  constructor() {
    this.components = [];
  }
  addComponents(...components) {
    this.components.push(...components);
    return this;
  }
}

class FakeModalBuilder {
  constructor() {
    this.data = { components: [] };
  }
  setCustomId(value) {
    this.data.customId = value;
    return this;
  }
  setTitle(value) {
    this.data.title = value;
    return this;
  }
  addComponents(...components) {
    this.data.components.push(...components);
    return this;
  }
}

class FakeTextInputBuilder {
  constructor() {
    this.data = {};
  }
  setCustomId(value) {
    this.data.customId = value;
    return this;
  }
  setLabel(value) {
    this.data.label = value;
    return this;
  }
  setStyle(value) {
    this.data.style = value;
    return this;
  }
  setRequired(value) {
    this.data.required = value;
    return this;
  }
  setMaxLength(value) {
    this.data.maxLength = value;
    return this;
  }
  setValue(value) {
    this.data.value = value;
    return this;
  }
}

function makeSubmit({ modalId, userId, fields }) {
  const replies = [];
  return {
    customId: modalId,
    user: { id: userId },
    replies,
    fields: {
      getTextInputValue(name) {
        return fields[name] || "";
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
  };
}

function makeInteraction({ userId = "lead", submit }) {
  const shownModals = [];
  return {
    user: { id: userId },
    shownModals,
    async showModal(modal) {
      shownModals.push(modal);
    },
    async awaitModalSubmit(options) {
      assert.equal(options.time, 120000);
      assert.equal(options.filter({ customId: "wrong", user: { id: userId } }), false);
      assert.equal(options.filter({ customId: submit.customId, user: { id: "other" } }), false);
      assert.equal(options.filter(submit), true);
      return submit;
    },
  };
}

function makeSavedEvent(overrides = {}) {
  return {
    _id: "event-1",
    guildId: "guild-1",
    roomName: "old-room",
    roomPassword: "old-pass",
    startAt: new Date(Date.UTC(2026, 4, 29, 5, 0)),
    saved: 0,
    async save() {
      this.saved += 1;
    },
    ...overrides,
  };
}

function makeActions({ event, editCalls }) {
  return createScheduleModalActions({
    ActionRowBuilder: FakeActionRowBuilder,
    ModalBuilder: FakeModalBuilder,
    TextInputBuilder: FakeTextInputBuilder,
    TextInputStyle: { Short: "short" },
    clip: (value, max) => String(value).slice(0, max),
    ephemeralFlag: 64,
    boardLang: async (guildId) => `board-${guildId}`,
    loadEvent: async (id) => (String(id) === String(event?._id) ? event : null),
    editBoardMessage: async (submit, fresh, lang) => {
      editCalls.push({ submit, fresh, lang });
      return true;
    },
    rejectUnlessLeadMutable: async () => false,
    noticePayload: (lang, tone, titleKey, descriptionKey) => ({
      lang,
      tone,
      titleKey,
      descriptionKey,
    }),
    noticeEmbed: (tone, title, description) => ({ tone, title, description }),
  });
}

test("schedule modal action saves room info and refreshes the board", async () => {
  const event = makeSavedEvent();
  const editCalls = [];
  const submit = makeSubmit({
    modalId: "rse:roommodal:event-1",
    userId: "lead",
    fields: { room: " Bckg ", password: " 1234 " },
  });
  const interaction = makeInteraction({ submit });
  const actions = makeActions({ event, editCalls });

  await actions.handleSetRoom(interaction, event, "vi");

  assert.equal(interaction.shownModals[0].data.customId, "rse:roommodal:event-1");
  const [roomRow, passwordRow] = interaction.shownModals[0].data.components;
  assert.equal(roomRow.components[0].data.customId, "room");
  assert.equal(passwordRow.components[0].data.customId, "password");
  assert.equal(event.roomName, "Bckg");
  assert.equal(event.roomPassword, "1234");
  assert.equal(event.saved, 1);
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0].lang, "board-guild-1");
  assert.equal(submit.replies[0].flags, 64);
  assert.equal(submit.replies[0].embeds[0].tone, "success");
});

test("schedule modal action saves a parsed start time and replies with Discord timestamps", async () => {
  const event = makeSavedEvent();
  const editCalls = [];
  const submit = makeSubmit({
    modalId: "rse:timemodal:event-1",
    userId: "lead",
    fields: { when: "+2h" },
  });
  const interaction = makeInteraction({ submit });
  const actions = makeActions({ event, editCalls });
  const before = Date.now();

  await actions.handleEditTime(interaction, event, "vi");

  const after = Date.now();
  assert.equal(interaction.shownModals[0].data.customId, "rse:timemodal:event-1");
  assert.equal(interaction.shownModals[0].data.components[0].components[0].data.customId, "when");
  assert.equal(event.saved, 1);
  assert.ok(event.startAt.getTime() >= before + 2 * 60 * 60 * 1000 - 1000);
  assert.ok(event.startAt.getTime() <= after + 2 * 60 * 60 * 1000 + 1000);
  assert.equal(editCalls.length, 1);
  assert.match(submit.replies[0].embeds[0].description, /<t:\d+:R>/);
  assert.match(submit.replies[0].embeds[0].description, /<t:\d+:f>/);
});
