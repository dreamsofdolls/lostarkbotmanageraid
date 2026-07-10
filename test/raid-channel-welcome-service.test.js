const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidChannelWelcomeService,
} = require("../bot/services/raid/channel-monitor/channel-monitor-welcome");
const {
  cleanupRaidChannelMessages,
} = require("../bot/services/raid/channel-monitor/channel-monitor-cleanup");
const {
  createRaidChannelGuard,
} = require("../bot/services/raid/channel-monitor/channel-monitor-guard");

function createGuildConfig({
  welcomeMessageId = null,
  welcomeChannelId = "channel-1",
  raidChannelId = "channel-1",
  persistThrows = false,
} = {}) {
  const updates = [];
  return {
    updates,
    findOne() {
      return {
        lean: async () => ({ welcomeMessageId, welcomeChannelId, raidChannelId }),
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

function createSentMessage(id, title = "en welcome title") {
  return {
    id,
    author: { id: "bot" },
    embeds: [{ title }],
    pinned: false,
    deleted: false,
    pinCount: 0,
    unpinCount: 0,
    deleteCount: 0,
    async pin() {
      this.pinCount += 1;
      this.pinned = true;
    },
    async unpin() {
      this.unpinCount += 1;
      this.pinned = false;
    },
    async delete() {
      this.deleteCount += 1;
      this.deleted = true;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeBatch(messages) {
  return {
    size: messages.length,
    last: () => messages[messages.length - 1] || null,
    filter: (predicate) => makeBatch(messages.filter(predicate)),
    map: (mapper) => messages.map(mapper),
  };
}

function createChannel({ id = "channel-1", pins = [], fetchById = new Map(), sent }) {
  const fetchCalls = [];
  const sends = [];
  return {
    id,
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

function createService({ GuildConfig, channelGuard = createRaidChannelGuard() }) {
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
    channelGuard,
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
    update: {
      $set: {
        welcomeMessageId: "fresh",
        welcomeChannelId: "channel-1",
      },
    },
    options: { upsert: true, setDefaultsOnInsert: true },
  });
});

test("raid-channel welcome and cleanup share one channel lock across the send-to-pin window", async () => {
  const channelGuard = createRaidChannelGuard();
  const pinStarted = deferred();
  const finishPin = deferred();
  const sent = createSentMessage("fresh");
  sent.pin = async () => {
    sent.pinCount += 1;
    pinStarted.resolve();
    await finishPin.promise;
    sent.pinned = true;
  };
  const GuildConfig = createGuildConfig({
    welcomeMessageId: null,
    welcomeChannelId: null,
  });
  let cleanupFetchCount = 0;
  let bulkDeleteCount = 0;
  const channel = {
    id: "channel-1",
    messages: {
      fetchPins: async () => ({ items: [] }),
      fetch: async () => {
        cleanupFetchCount += 1;
        return makeBatch([{ id: sent.id, pinned: false }]);
      },
    },
    send: async () => sent,
    bulkDelete: async (collection) => {
      bulkDeleteCount += 1;
      return { size: collection.size };
    },
  };
  const service = createService({ GuildConfig, channelGuard });

  const welcomePromise = service.postRaidChannelWelcome(channel, "bot", "guild-1");
  await pinStarted.promise;
  const cleanupPromise = cleanupRaidChannelMessages(channel, { channelGuard });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cleanupFetchCount, 0, "cleanup must wait while the welcome is being pinned");
  finishPin.resolve();
  const [welcome, cleanup] = await Promise.all([welcomePromise, cleanupPromise]);

  assert.equal(welcome.pinned, true);
  assert.equal(welcome.persisted, true);
  assert.deepEqual(cleanup, { deleted: 0, skippedOld: 0 });
  assert.equal(cleanupFetchCount, 1);
  assert.equal(bulkDeleteCount, 0);
  assert.equal(sent.deleted, false);
});

test("concurrent raid-channel repins serialize and leave only the newest welcome", async () => {
  const channelGuard = createRaidChannelGuard();
  const old = createSentMessage("old", "vi welcome title");
  old.pinned = true;
  const freshA = createSentMessage("fresh-a");
  const freshB = createSentMessage("fresh-b");
  const messages = new Map([
    [old.id, old],
    [freshA.id, freshA],
    [freshB.id, freshB],
  ]);
  const state = {
    welcomeMessageId: old.id,
    welcomeChannelId: "channel-1",
    raidChannelId: "channel-1",
  };
  const GuildConfig = {
    findOne: () => ({ lean: async () => ({ ...state }) }),
    findOneAndUpdate: async (_query, update) => {
      Object.assign(state, update.$set);
      return { ...state };
    },
  };
  let sendIndex = 0;
  const freshMessages = [freshA, freshB];
  const channel = {
    id: "channel-1",
    messages: {
      fetchPins: async () => ({
        items: [...messages.values()]
          .filter((message) => message.pinned && !message.deleted)
          .map((message) => ({ message })),
      }),
      fetch: async (messageId) => {
        const message = messages.get(messageId);
        if (!message || message.deleted) throw new Error("message unavailable");
        return message;
      },
    },
    send: async () => freshMessages[sendIndex++],
  };
  const service = createService({ GuildConfig, channelGuard });

  const outcomes = await Promise.all([
    service.postRaidChannelWelcome(channel, "bot", "guild-1"),
    service.postRaidChannelWelcome(channel, "bot", "guild-1"),
  ]);

  assert.deepEqual(outcomes.map((outcome) => outcome.removedOldCount), [1, 1]);
  assert.equal(old.deleted, true);
  assert.equal(freshA.deleted, true);
  assert.equal(freshB.deleted, false);
  assert.equal(freshB.pinned, true);
  assert.equal(state.welcomeMessageId, freshB.id);
  assert.deepEqual(channelGuard.getProtectedMessageIds(channel.id), [freshB.id]);
});

test("moving raid channel deletes the tracked welcome from its original channel", async () => {
  const channelGuard = createRaidChannelGuard();
  const old = createMessage("old", "vi welcome title");
  const fresh = createSentMessage("fresh");
  const GuildConfig = createGuildConfig({
    welcomeMessageId: old.id,
    welcomeChannelId: "old-channel",
    raidChannelId: "new-channel",
  });
  const oldChannel = {
    id: "old-channel",
    messages: { fetch: async () => old },
  };
  const newChannel = createChannel({ id: "new-channel", sent: fresh });
  const client = {
    channels: {
      cache: new Map(),
      fetch: async (channelId) => (channelId === oldChannel.id ? oldChannel : null),
    },
  };
  const service = createService({ GuildConfig, channelGuard });

  const outcome = await service.postRaidChannelWelcome(
    newChannel,
    "bot",
    "guild-1",
    { client }
  );

  assert.equal(outcome.removedOldCount, 1);
  assert.equal(old.deleted, true);
  assert.deepEqual(GuildConfig.updates[0].update.$set, {
    welcomeMessageId: fresh.id,
    welcomeChannelId: newChannel.id,
  });
  assert.deepEqual(channelGuard.getProtectedMessageIds(newChannel.id), [fresh.id]);
});

test("moving a legacy raid channel uses the previous monitor channel as welcome fallback", async () => {
  const old = createMessage("old", "vi welcome title");
  const fresh = createSentMessage("fresh");
  const GuildConfig = createGuildConfig({
    welcomeMessageId: old.id,
    welcomeChannelId: null,
    raidChannelId: "new-channel",
  });
  const oldChannel = {
    id: "old-channel",
    messages: { fetch: async () => old },
  };
  const newChannel = createChannel({ id: "new-channel", sent: fresh });
  const client = {
    channels: {
      fetch: async (channelId) => (channelId === oldChannel.id ? oldChannel : null),
    },
  };
  const service = createService({ GuildConfig });

  const outcome = await service.postRaidChannelWelcome(
    newChannel,
    "bot",
    "guild-1",
    { client, previousChannelId: oldChannel.id }
  );

  assert.equal(outcome.removedOldCount, 1);
  assert.equal(old.deleted, true);
});

test("raid-channel welcome rollback removes the fresh message when pinning fails", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const old = createMessage("old", "vi welcome title");
    const sent = createSentMessage("fresh");
    sent.pin = async () => {
      sent.pinCount += 1;
      throw new Error("pin failed");
    };
    const GuildConfig = createGuildConfig({ welcomeMessageId: old.id });
    const channel = createChannel({
      fetchById: new Map([[old.id, old]]),
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
    assert.equal(sent.unpinCount, 1);
    assert.equal(sent.deleteCount, 1);
    assert.equal(old.deleted, false);
    assert.equal(GuildConfig.updates.length, 0);
  } finally {
    console.warn = originalWarn;
  }
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
    assert.equal(sent.deleteCount, 1);
    assert.equal(trackedOld.deleted, false);
    assert.deepEqual(channel.fetchCalls, []);
  } finally {
    console.warn = originalWarn;
  }
});
