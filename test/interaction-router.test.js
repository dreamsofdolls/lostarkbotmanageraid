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
const { EmbedBuilder } = require("discord.js");
const { NoticeKind, buildNoticeEmbed } = require("../bot/utils/raid/common/shared");

const FAILURE_ICON = buildNoticeEmbed(EmbedBuilder, { kind: NoticeKind.FAILURE, title: "x" }).toJSON().title.slice(0, -1);

// The catch-all reply as the user reads it: a failure card, no detail field.
function failureReply(method, lang) {
  return [method, {
    flags: 64,
    content: undefined,
    title: `${FAILURE_ICON}${translate("common.notice.commandFailedTitle", lang)}`,
    description: translate("common.notice.commandFailedDescription", lang),
    tip: `💡 ${translate("common.notice.commandFailedTip", lang)}`,
    fields: undefined,
  }];
}

function readReply([method, payload]) {
  const card = payload.embeds?.[0]?.toJSON();
  return [method, {
    flags: payload.flags,
    content: payload.content,
    title: card?.title,
    description: card?.description,
    tip: card?.footer?.text,
    fields: card?.fields,
  }];
}

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
    EmbedBuilder,
    allowedCommands: ["raid-status"],
    handleSlashCommand,
    autocompleteHandlers: {},
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

  assert.deepEqual(english.payloads.map(readReply), [failureReply("reply", "en")]);
  assert.deepEqual(japanese.payloads.map(readReply), [failureReply("followUp", "jp")]);
  assert.notEqual(
    translate("common.notice.commandFailedTitle", "en"),
    translate("common.notice.commandFailedTitle", "vi")
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
  assert.deepEqual(interaction.payloads.map(readReply), [failureReply("reply", "vi")]);
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

  assert.deepEqual(interaction.payloads.map(readReply), [failureReply("reply", "vi")]);
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

function createKindInteraction(kind, { id, customId = "", commandName = "raid-status", respond } = {}) {
  return {
    ...createChatInteraction({ id, commandName }),
    customId,
    isChatInputCommand: () => kind === "chat",
    isAutocomplete: () => kind === "autocomplete",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
    isButton: () => kind === "button",
    respond: respond || (async () => {}),
  };
}

function createRoutingRouter(calls) {
  const route = (prefix, name = prefix) => ({ prefix, handle: async () => calls.push(name) });
  return createInteractionRouter({
    MessageFlags: { Ephemeral: 64 },
    allowedCommands: ["raid-status"],
    handleSlashCommand: async (interaction) => calls.push(`slash:${interaction.commandName}`),
    autocompleteHandlers: { "raid-set": async () => calls.push("auto:raid-set") },
    selectRoutes: [route("sel:"), route("sel:a", "sel-a")],
    buttonRoutes: [route("btn", "btn-any"), route("btn-a:")],
    modalRoutes: [route("modal:")],
    instanceIdentity: "test",
    log: createLogCapture().log,
  });
}

test("interaction router sends each interaction kind to its own handler, first matching prefix winning", async () => {
  const calls = [];
  const router = createRoutingRouter(calls);
  await router.handle(createKindInteraction("chat", { id: "kind-1" }));
  await router.handle(createKindInteraction("chat", { id: "kind-2", commandName: "not-allowed" }));
  await router.handle(createKindInteraction("autocomplete", { id: "kind-3", commandName: "raid-set" }));
  await router.handle(createKindInteraction("select", { id: "kind-4", customId: "sel:a:1" }));
  await router.handle(createKindInteraction("modal", { id: "kind-5", customId: "modal:9" }));
  await router.handle(createKindInteraction("button", { id: "kind-6", customId: "btn-a:2" }));
  await router.handle(createKindInteraction("button", { id: "kind-7", customId: "zzz" }));
  assert.deepEqual(calls, ["slash:raid-status", "auto:raid-set", "sel:", "modal:", "btn-any"]);
});

test("interaction router answers an unknown autocomplete with no suggestions", async () => {
  const calls = [];
  const responses = [];
  const router = createRoutingRouter(calls);
  await router.handle(createKindInteraction("autocomplete", {
    id: "kind-8",
    commandName: "unknown",
    respond: async (choices) => responses.push(choices),
  }));
  assert.deepEqual(responses, [[]]);
  assert.deepEqual(calls, []);
});

test("interaction router routes a button whose interaction has no isModalSubmit", async () => {
  const calls = [];
  const router = createRoutingRouter(calls);
  const { isModalSubmit, ...button } = createKindInteraction("button", { id: "kind-9", customId: "btn-a:1" });
  assert.equal(typeof isModalSubmit, "function");
  await router.handle(button);
  assert.deepEqual(calls, ["btn-any"]);
});
