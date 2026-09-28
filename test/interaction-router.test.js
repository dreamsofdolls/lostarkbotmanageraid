"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInteractionRouter,
  isAlreadyAcknowledgedError,
  isUnknownInteractionError,
} = require("../bot/services/discord/interaction-router");
const {
  clearUserLanguageCache,
  t: translate,
} = require("../bot/services/i18n");

function createLogCapture() {
  const warnings = [];
  const errors = [];
  return {
    warnings,
    errors,
    log: {
      warn: (...args) => warnings.push(args.join(" ")),
      error: (...args) => errors.push(args.join(" ")),
    },
  };
}

function createChatInteraction({
  id = "interaction-1",
  ageMs = 250,
  commandName = "raid-status",
} = {}) {
  const calls = {
    followUp: 0,
    reply: 0,
  };
  return {
    id,
    commandName,
    createdTimestamp: Date.now() - ageMs,
    deferred: false,
    replied: false,
    calls,
    isAutocomplete: () => false,
    isButton: () => false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    isStringSelectMenu: () => false,
    followUp: async () => {
      calls.followUp += 1;
    },
    reply: async () => {
      calls.reply += 1;
    },
  };
}

function createTestRouter({ handleSlashCommand, log, UserModel }) {
  return createInteractionRouter({
    MessageFlags: { Ephemeral: 64 },
    allowedCommands: ["raid-status"],
    handleSlashCommand,
    autocompleteHandlers: {},
    selectHandlers: {},
    buttonRoutes: [],
    instanceIdentity:
      "service=raid-manage environment=production deployment=deploy-1 replica=replica-1 pid=42",
    log,
    UserModel,
  });
}

// A chat interaction from `userId` that records every reply / followUp payload.
function createRecordingInteraction({ id, userId, deferred = false }) {
  const payloads = [];
  return {
    ...createChatInteraction({ id }),
    user: { id: userId },
    deferred,
    payloads,
    followUp: async (payload) => {
      payloads.push(["followUp", payload]);
    },
    reply: async (payload) => {
      payloads.push(["reply", payload]);
    },
  };
}

test("interaction router recognizes Discord acknowledgement error codes", () => {
  assert.equal(isAlreadyAcknowledgedError({ code: 40060 }), true);
  assert.equal(isAlreadyAcknowledgedError({ rawError: { code: 40060 } }), true);
  assert.equal(
    isAlreadyAcknowledgedError({ code: null, rawError: { code: 40060 } }),
    true
  );
  assert.equal(isAlreadyAcknowledgedError({ code: 10062 }), false);
  assert.equal(isUnknownInteractionError({ code: 10062 }), true);
  assert.equal(isUnknownInteractionError({ rawError: { code: 10062 } }), true);
});

test("interaction router treats 40060 as duplicate acknowledgement without a second reply", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const capture = createLogCapture();
  const interaction = createChatInteraction({ ageMs: 500 });
  const error = Object.assign(
    new Error("Interaction has already been acknowledged."),
    { code: 40060 }
  );
  const router = createTestRouter({
    handleSlashCommand: async () => {
      throw error;
    },
    log: capture.log,
  });

  await router.handle(interaction);

  assert.equal(capture.errors.length, 0);
  assert.equal(capture.warnings.length, 1);
  assert.match(capture.warnings[0], /duplicate acknowledgement ignored/);
  assert.match(capture.warnings[0], /interactionId=interaction-1/);
  assert.match(capture.warnings[0], /replica=replica-1/);
  assert.equal(interaction.calls.reply, 0);
  assert.equal(interaction.calls.followUp, 0);
});

test("interaction router flags 10062 before deadline as possible duplicate consumer", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const capture = createLogCapture();
  const interaction = createChatInteraction({ id: "interaction-2", ageMs: 600 });
  const error = Object.assign(new Error("Unknown interaction"), { code: 10062 });
  const router = createTestRouter({
    handleSlashCommand: async () => {
      throw error;
    },
    log: capture.log,
  });

  await router.handle(interaction);

  assert.equal(capture.errors.length, 0);
  assert.equal(capture.warnings.length, 1);
  assert.match(capture.warnings[0], /duplicate consumer suspected/);
  assert.doesNotMatch(capture.warnings[0], /stale interaction ignored/);
  assert.equal(interaction.calls.reply, 0);
});

test("interaction router keeps genuinely expired 10062 classified as stale", async () => {
  const capture = createLogCapture();
  const interaction = createChatInteraction({
    id: "interaction-expired",
    ageMs: 3_500,
  });
  const error = Object.assign(new Error("Unknown interaction"), { code: 10062 });
  const router = createTestRouter({
    handleSlashCommand: async () => {
      throw error;
    },
    log: capture.log,
  });

  await router.handle(interaction);

  assert.equal(capture.errors.length, 0);
  assert.equal(capture.warnings.length, 1);
  assert.match(capture.warnings[0], /stale interaction ignored/);
  assert.doesNotMatch(capture.warnings[0], /duplicate consumer suspected/);
  assert.equal(interaction.calls.reply, 0);
});

test("interaction router preserves generic error reply behavior", async () => {
  const capture = createLogCapture();
  const interaction = createChatInteraction({ id: "interaction-error" });
  const router = createTestRouter({
    handleSlashCommand: async () => {
      throw new Error("unexpected failure");
    },
    log: capture.log,
  });

  await router.handle(interaction);

  assert.equal(capture.errors.length, 1);
  assert.equal(capture.warnings.length, 0);
  assert.equal(interaction.calls.reply, 1);
  assert.equal(interaction.calls.followUp, 0);
});

test("interaction router answers an unhandled error in the user's language", async () => {
  clearUserLanguageCache();
  const capture = createLogCapture();
  const languages = { "router-user-en": "en", "router-user-jp": "jp" };
  const router = createTestRouter({
    handleSlashCommand: async () => {
      throw new Error("unexpected failure");
    },
    log: capture.log,
    UserModel: {
      findOne: ({ discordId }) => ({
        lean: async () => ({ language: languages[discordId] }),
      }),
    },
  });
  const english = createRecordingInteraction({
    id: "interaction-error-en",
    userId: "router-user-en",
  });
  const japanese = createRecordingInteraction({
    id: "interaction-error-jp",
    userId: "router-user-jp",
    deferred: true,
  });

  await router.handle(english);
  await router.handle(japanese);

  assert.deepEqual(english.payloads, [
    ["reply", { content: translate("common.genericError", "en"), flags: 64 }],
  ]);
  assert.deepEqual(japanese.payloads, [
    ["followUp", { content: translate("common.genericError", "jp"), flags: 64 }],
  ]);
  assert.notEqual(
    translate("common.genericError", "en"),
    translate("common.genericError", "vi")
  );
});

test("interaction router falls back to the default language when the lookup fails", async () => {
  clearUserLanguageCache();
  const capture = createLogCapture();
  const interaction = createRecordingInteraction({
    id: "interaction-error-lookup-fails",
    userId: "router-user-db-down",
  });
  const router = createTestRouter({
    handleSlashCommand: async () => {
      throw new Error("unexpected failure");
    },
    log: capture.log,
    UserModel: {
      findOne() {
        throw new Error("MongoServerSelectionError");
      },
    },
  });

  await router.handle(interaction);

  assert.equal(capture.errors.length, 1);
  assert.deepEqual(interaction.payloads, [
    ["reply", { content: translate("common.genericError", "vi"), flags: 64 }],
  ]);
});

test("interaction router does not hold the error reply for a stalled language lookup", async (t) => {
  clearUserLanguageCache();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capture = createLogCapture();
  const interaction = createRecordingInteraction({
    id: "interaction-error-lookup-stalls",
    userId: "router-user-db-stalled",
  });
  const router = createTestRouter({
    handleSlashCommand: async () => {
      throw new Error("unexpected failure");
    },
    log: capture.log,
    UserModel: {
      findOne: () => ({ lean: () => new Promise(() => {}) }),
    },
  });

  const handled = router.handle(interaction);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interaction.payloads, []);
  t.mock.timers.tick(1_000);
  await handled;

  assert.deepEqual(interaction.payloads, [
    ["reply", { content: translate("common.genericError", "vi"), flags: 64 }],
  ]);
  clearUserLanguageCache();
});

test("interaction router dispatches the same interaction ID once per process", async () => {
  const capture = createLogCapture();
  const interaction = createChatInteraction({ id: "interaction-3" });
  let dispatchCalls = 0;
  const router = createTestRouter({
    handleSlashCommand: async () => {
      dispatchCalls += 1;
      await Promise.resolve();
    },
    log: capture.log,
  });

  await Promise.all([router.handle(interaction), router.handle(interaction)]);

  assert.equal(dispatchCalls, 1);
  assert.equal(capture.warnings.length, 1);
  assert.match(capture.warnings[0], /duplicate in-process dispatch ignored/);
  assert.match(capture.warnings[0], /interactionId=interaction-3/);
});
