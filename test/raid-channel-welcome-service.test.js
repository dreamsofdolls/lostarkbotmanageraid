const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidChannelWelcomeService,
} = require("../bot/services/raid/channel-monitor/channel-monitor-welcome");

function createGuildConfig({ welcomeMessageId = null, persistThrows = false } = {}) {
  const updates = [];
  return {
    updates,
    findOne() {
      return {
        lean: async () => ({ welcomeMessageId }),
      };
    },
    async findOneAndUpdate(query, update, options) {
      if (persistThrows) throw new Error("persist failed");
      updates.push({ query, update, options });
      return {};
    },
  };
}

function createMessage(id, title, authorId = "bot") {
  return {
    id,
    author: { id: authorId },
    embeds: [{ title }],
    deleted: false,
    async delete() {
      this.deleted = true;
    },
  };
}

function createSentMessage(id) {
  return {
    id,
    pinCount: 0,
    unpinCount: 0,
    async pin() {
      this.pinCount += 1;
    },
    async unpin() {
      this.unpinCount += 1;
    },
  };
}

function createChannel({ pins = [], fetchById = new Map(), sent }) {
  const fetchCalls = [];
  const sends = [];
  return {
    fetchCalls,
    sends,
    messages: {
      async fetchPins() {
        return { items: pins.map((message) => ({ message })) };
      },
      async fetch(id) {
        fetchCalls.push(id);
        const message = fetchById.get(id);
        if (!message) throw new Error(`missing message ${id}`);
        return message;
      },
    },
    async send(payload) {
      sends.push(payload);
      return sent;
    },
  };
}

function createService({ GuildConfig }) {
  const titles = {
    vi: "vi welcome title",
    jp: "jp welcome title",
    en: "en welcome title",
  };

  return createRaidChannelWelcomeService({
    GuildConfig,
    getGuildLanguage: async () => "en",
    buildRaidChannelWelcomeEmbed: (lang) => ({
      lang,
      toJSON: () => ({ title: titles[lang] || titles.vi }),
    }),
    welcomeTitleLanguages: Object.keys(titles),
  });
}

test("raid-channel welcome service deletes stale welcomes only after fresh pin is persisted", async () => {
  const trackedOld = createMessage("tracked-old", "vi welcome title");
  const orphanPin = createMessage("orphan-old", "jp welcome title");
  const unrelatedBotPin = createMessage("unrelated", "not a welcome");
  const otherAuthorPin = createMessage("other-author", "en welcome title", "someone-else");
  const sent = createSentMessage("fresh");
  const GuildConfig = createGuildConfig({ welcomeMessageId: trackedOld.id });
  const channel = createChannel({
    pins: [orphanPin, unrelatedBotPin, otherAuthorPin],
    fetchById: new Map([
      [trackedOld.id, trackedOld],
      [orphanPin.id, orphanPin],
      [unrelatedBotPin.id, unrelatedBotPin],
      [otherAuthorPin.id, otherAuthorPin],
    ]),
    sent,
  });

  const service = createService({ GuildConfig });
  const outcome = await service.postRaidChannelWelcome(channel, "bot", "guild-1");

  assert.deepEqual(outcome, {
    posted: true,
    pinned: true,
    persisted: true,
    removedOldCount: 2,
  });
  assert.equal(sent.pinCount, 1);
  assert.equal(sent.unpinCount, 0);
  assert.equal(trackedOld.deleted, true);
  assert.equal(orphanPin.deleted, true);
  assert.equal(unrelatedBotPin.deleted, false);
  assert.equal(otherAuthorPin.deleted, false);
  assert.deepEqual(GuildConfig.updates[0], {
    query: { guildId: "guild-1" },
    update: { $set: { welcomeMessageId: "fresh" } },
    options: { upsert: true, setDefaultsOnInsert: true },
  });
});

test("raid-channel welcome service leaves stale welcomes when fresh persist fails", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const trackedOld = createMessage("tracked-old", "vi welcome title");
    const sent = createSentMessage("fresh");
    const GuildConfig = createGuildConfig({
      welcomeMessageId: trackedOld.id,
      persistThrows: true,
    });
    const channel = createChannel({
      pins: [],
      fetchById: new Map([[trackedOld.id, trackedOld]]),
      sent,
    });

    const service = createService({ GuildConfig });
    const outcome = await service.postRaidChannelWelcome(channel, "bot", "guild-1");

    assert.deepEqual(outcome, {
      posted: true,
      pinned: false,
      persisted: false,
      removedOldCount: 0,
    });
    assert.equal(sent.pinCount, 1);
    assert.equal(sent.unpinCount, 1);
    assert.equal(trackedOld.deleted, false);
    assert.deepEqual(channel.fetchCalls, []);
  } finally {
    console.warn = originalWarn;
  }
});
