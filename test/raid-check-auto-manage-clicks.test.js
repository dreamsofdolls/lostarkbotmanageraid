"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidCheckAutoManageUi,
} = require("../bot/handlers/raid-check/auto-manage/auto-manage");

class FakeEmbedBuilder {
  constructor() {
    this.data = { fields: [] };
  }

  setColor(color) {
    this.data.color = color;
    return this;
  }

  setTitle(title) {
    this.data.title = title;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  setFooter(footer) {
    this.data.footer = footer;
    return this;
  }

  addFields(...fields) {
    this.data.fields.push(...fields);
    return this;
  }
}

class FakeActionRowBuilder {
  constructor() {
    this.components = [];
  }

  addComponents(...components) {
    this.components.push(...components);
    return this;
  }
}

class FakeButtonBuilder {
  constructor() {
    this.data = {};
  }

  setCustomId(customId) {
    this.data.customId = customId;
    return this;
  }

  setLabel(label) {
    this.data.label = label;
    return this;
  }

  setEmoji(emoji) {
    this.data.emoji = emoji;
    return this;
  }

  setStyle(style) {
    this.data.style = style;
    return this;
  }
}

function makeUserModel({ findOneAndUpdateImpl } = {}) {
  const calls = { findOne: [], findOneAndUpdate: [] };
  return {
    calls,
    findOneAndUpdate(filter, update, options) {
      calls.findOneAndUpdate.push({ filter, update, options });
      return typeof findOneAndUpdateImpl === "function"
        ? findOneAndUpdateImpl(filter, update, options)
        : Promise.resolve(null);
    },
    findOne(filter) {
      calls.findOne.push({ filter });
      return {
        lean: async () => null,
        select: () => ({ lean: async () => null }),
      };
    },
  };
}

function createUi(User) {
  return createRaidCheckAutoManageUi({
    ActionRowBuilder: FakeActionRowBuilder,
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle: { Danger: "danger", Primary: "primary" },
    EmbedBuilder: FakeEmbedBuilder,
    MessageFlags: { Ephemeral: 64 },
    User,
    buildNoticeEmbed: (EmbedBuilder, payload) => payload,
  });
}

function makeInteraction({ userId = "manager-1", targetSends = [] } = {}) {
  return {
    user: { id: userId },
    replies: [],
    updates: [],
    client: {
      users: {
        fetch: async (id) => ({
          id,
          async send(payload) {
            targetSends.push(payload);
          },
        }),
      },
    },
    async reply(payload) {
      this.replies.push(payload);
    },
    async update(payload) {
      this.updates.push(payload);
    },
  };
}

test("raid-check auto-manage manager enable sends target DM and success reply", async () => {
  const targetSends = [];
  const User = makeUserModel({
    findOneAndUpdateImpl: () =>
      Promise.resolve({
        discordId: "user-1",
        autoManageEnabled: true,
        accounts: [
          {
            accountName: "Alpha",
            characters: [{ name: "Qiylyn", itemLevel: 1730, publicLogDisabled: false }],
          },
        ],
      }),
  });
  const ui = createUi(User);
  const interaction = makeInteraction({ targetSends });

  await ui.handleRaidCheckEnableAutoOneClick(interaction, "user-1");

  assert.equal(User.calls.findOneAndUpdate.length, 1);
  assert.deepEqual(User.calls.findOneAndUpdate[0].filter.localSyncEnabled, { $ne: true });
  assert.equal(targetSends.length, 1);
  assert.equal(targetSends[0].components[0].components[0].data.customId, "raid-check:disable-auto-self:user-1");
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].embeds[0].type, "success");
});

test("raid-check auto-manage self disable rejects clicks from a different user", async () => {
  const User = makeUserModel({
    findOneAndUpdateImpl: () => {
      throw new Error("state transition should not run");
    },
  });
  const ui = createUi(User);
  const interaction = makeInteraction({ userId: "intruder" });

  await ui.handleRaidCheckDisableAutoSelfClick(interaction, "user-1");

  assert.equal(User.calls.findOneAndUpdate.length, 0);
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].embeds[0].type, "lock");
});
