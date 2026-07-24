"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInteractionRouter,
  isAlreadyAcknowledgedError,
  isUnknownInteractionError,
} = require("../bot/services/discord/interaction-router");

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

function createTestRouter({ handleSlashCommand, log }) {
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
  });
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
