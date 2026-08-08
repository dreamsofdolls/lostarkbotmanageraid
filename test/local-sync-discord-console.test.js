process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { UI } = require("../bot/utils/raid/common/shared");
const {
  buildLocalSyncConsolePayload,
} = require("../bot/handlers/local-sync/discord-console-ui");
const {
  buildRaidStatusHandoffContent,
  createLocalSyncDiscordConsole,
  shouldOpenRaidStatusSurface,
} = require("../bot/handlers/local-sync/discord-console");
const {
  applyPreviewJob,
  cancelPreviewJob,
  COMPANION_SCOPE,
  PREVIEW_APPLY_LEASE_MS,
} = require("../bot/services/local-sync");

function makeJob(overrides = {}) {
  return {
    jobId: "11111111-2222-4333-8444-555555555555",
    discordId: "u1",
    scope: "full",
    status: "pending",
    failureReason: "",
    tokenFingerprint: "",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    deltas: [{
      boss: "Armoche, Sentinel of the Abyss",
      difficulty: "Hard",
      cleared: true,
      charName: "Aki",
      lastClearMs: Date.now(),
    }],
    ...overrides,
  };
}

function componentIds(payload) {
  return payload.components.flatMap((row) =>
    row.toJSON().components.map((component) => component.custom_id || component.url)
  );
}

test("pending Discord console renders preview details and durable job buttons", () => {
  const job = makeJob();
  const payload = buildLocalSyncConsolePayload({
    job,
    summary: {
      changes: { chars: 1, raids: 1, gates: 1 },
      changeDetails: [{
        charName: "Aki",
        raids: [{ raidKey: "armoche", modeKey: "hard", gates: ["G2"] }],
      }],
      completion: { percent: 25, projectedPercent: 50 },
      goldDelta: { total: 17_000 },
    },
    readerUrl: "https://example.test/sync?token=x",
    activeScope: "full",
    lang: "vi",
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
    formatGold: (value) => `${value} G`,
  });

  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /Local Sync Console/);
  assert.match(embed.description, /Chờ xác nhận/);
  const characterField = embed.fields.find((field) => field.name === "Aki");
  assert.ok(characterField);
  assert.match(characterField.value, /G2/);
  assert.doesNotMatch(characterField.value, /G1/);
  assert.deepEqual(componentIds(payload), [
    `local-sync:apply:${job.jobId}`,
    `local-sync:cancel:${job.jobId}`,
    `local-sync:refresh:${job.jobId}`,
    "https://example.test/sync?token=x",
  ]);
});

test("expired Discord console removes apply and cancel actions", () => {
  const job = makeJob({ expiresAt: new Date(Date.now() - 1) });
  const payload = buildLocalSyncConsolePayload({
    job,
    summary: { changes: { chars: 1, raids: 1, gates: 1 } },
    activeScope: "full",
    lang: "en",
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
  });

  assert.deepEqual(componentIds(payload), [`local-sync:refresh:${job.jobId}`]);
  assert.match(payload.embeds[0].toJSON().description, /Expired/);
});

test("retryable write errors keep the Sync action and explain what was retained", () => {
  const job = makeJob({ failureReason: "write_error" });
  const payload = buildLocalSyncConsolePayload({
    job,
    summary: { changes: { chars: 1, raids: 1, gates: 1 } },
    activeScope: "full",
    lang: "vi",
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
  });

  assert.match(payload.embeds[0].toJSON().description, /chưa ghi được vào DB/);
  assert.ok(componentIds(payload).includes(`local-sync:apply:${job.jobId}`));
});

test("raid-sync reserves the review console for actionable preview states", () => {
  const scope = COMPANION_SCOPE.full;
  assert.equal(shouldOpenRaidStatusSurface(null, scope), true);
  assert.equal(shouldOpenRaidStatusSurface(makeJob(), scope), false);
  assert.equal(shouldOpenRaidStatusSurface(makeJob({ status: "applying" }), scope), false);
  assert.equal(shouldOpenRaidStatusSurface(makeJob({ status: "failed" }), scope), false);
  assert.equal(shouldOpenRaidStatusSurface(makeJob({ status: "applied" }), scope), true);
  assert.equal(shouldOpenRaidStatusSurface(makeJob({ status: "cancelled" }), scope), true);
  assert.equal(shouldOpenRaidStatusSurface(makeJob({ status: "superseded" }), scope), true);
  assert.equal(
    shouldOpenRaidStatusSurface(makeJob({ expiresAt: new Date(Date.now() - 1) }), scope),
    true
  );
  assert.equal(shouldOpenRaidStatusSurface(makeJob({ status: "applied" }), null), false);
});

function makeConsoleUserQuery(userDoc) {
  return {
    select() { return this; },
    async lean() { return userDoc; },
  };
}

function makeConsoleUserModel(userDoc) {
  return {
    findOne() {
      return makeConsoleUserQuery(userDoc);
    },
    async findOneAndUpdate() {
      return userDoc;
    },
    async updateOne() {
      return { matchedCount: 1 };
    },
  };
}

function makeRaidSyncInteraction(discordId) {
  const deferred = [];
  const edits = [];
  return {
    deferred,
    edits,
    user: { id: discordId, username: "Aki" },
    async deferReply(payload) {
      deferred.push(payload);
    },
    async editReply(payload) {
      edits.push(payload);
      return payload;
    },
  };
}

test("raid-sync reuses the full raid-status session after an applied preview", async () => {
  const discordId = "raid-sync-status-handoff-user";
  const userDoc = {
    discordId,
    language: "en",
    localSyncEnabled: true,
    autoManageEnabled: false,
    accounts: [],
  };
  const appliedJob = makeJob({
    discordId,
    status: "applied",
    result: { applied: [{ id: 1 }], skipped: [], rejected: [] },
  });
  const handoffs = [];
  const service = createLocalSyncDiscordConsole({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: makeConsoleUserModel(userDoc),
    PreviewModel: { findOne: () => appliedJob },
    openRaidStatusSession: async (interaction, options) => {
      handoffs.push({ interaction, options });
    },
  });
  const interaction = makeRaidSyncInteraction(discordId);

  await service.handleRaidSyncCommand(interaction);

  assert.deepEqual(interaction.deferred, [{ flags: 64 }]);
  assert.equal(interaction.edits.length, 0);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].interaction, interaction);
  assert.equal(handoffs[0].options.alreadyDeferred, true);
  assert.equal(
    handoffs[0].options.content,
    buildRaidStatusHandoffContent(appliedJob, "en")
  );
  assert.match(handoffs[0].options.content, /Sync complete/);
});

test("raid-sync keeps pending previews in the durable confirmation console", async () => {
  const discordId = "raid-sync-pending-console-user";
  const userDoc = {
    discordId,
    language: "en",
    localSyncEnabled: true,
    autoManageEnabled: false,
    accounts: [],
  };
  const pendingJob = makeJob({ discordId });
  const handoffs = [];
  const service = createLocalSyncDiscordConsole({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: makeConsoleUserModel(userDoc),
    PreviewModel: { findOne: () => pendingJob },
    openRaidStatusSession: async (...args) => handoffs.push(args),
  });
  const interaction = makeRaidSyncInteraction(discordId);
  const previousBaseUrl = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  try {
    await service.handleRaidSyncCommand(interaction);
  } finally {
    if (previousBaseUrl == null) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  }

  assert.equal(handoffs.length, 0);
  assert.equal(interaction.edits.length, 1);
  assert.match(interaction.edits[0].embeds[0].toJSON().title, /Local Sync Console/);
  assert.ok(componentIds(interaction.edits[0]).includes(`local-sync:apply:${pendingJob.jobId}`));
});

test("reopening a pending console re-projects it from the latest User snapshot", async () => {
  const discordId = "raid-sync-fresh-projection-user";
  const userDoc = {
    discordId,
    language: "en",
    localSyncEnabled: true,
    autoManageEnabled: false,
    accounts: [],
  };
  const pendingJob = makeJob({
    discordId,
    projection: {
      changes: { chars: 99, raids: 99, gates: 99 },
    },
  });
  const service = createLocalSyncDiscordConsole({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: makeConsoleUserModel(userDoc),
  });
  const previousBaseUrl = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  let payload;
  try {
    payload = await service.buildConsole(
      { id: discordId, username: "Aki" },
      { job: pendingJob, lang: "en", userDoc }
    );
  } finally {
    if (previousBaseUrl == null) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  }

  const changesField = payload.embeds[0].toJSON().fields.find(
    (field) => field.name === "Changes"
  );
  assert.match(changesField.value, /\*\*0\*\* chars/);
  assert.doesNotMatch(changesField.value, /99/);
});

test("a successful Discord apply replaces the console with a live raid-status session", async () => {
  const discordId = "raid-sync-apply-handoff-user";
  const userDoc = {
    discordId,
    language: "en",
    localSyncEnabled: true,
    autoManageEnabled: false,
    lastLocalSyncToken: null,
    accounts: [{
      accountName: "Roster",
      characters: [{
        name: "Aki",
        class: "Artist",
        itemLevel: 1750,
        isGoldEarner: true,
        assignedRaids: {},
      }],
    }],
  };
  const pendingJob = makeJob({ discordId });
  const PreviewModel = makePreviewModel(pendingJob);
  const handoffs = [];
  const interaction = {
    customId: `local-sync:apply:${pendingJob.jobId}`,
    user: { id: discordId, username: "Aki" },
    deferredUpdates: 0,
    edits: [],
    async deferUpdate() {
      this.deferredUpdates += 1;
    },
    async editReply(payload) {
      this.edits.push(payload);
      return payload;
    },
  };
  const service = createLocalSyncDiscordConsole({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: makeConsoleUserModel(userDoc),
    PreviewModel,
    applyRaidSetForDiscordId: async () => ({
      matched: true,
      updated: true,
      displayName: "Aki",
    }),
    openRaidStatusSession: async (sourceInteraction, options) => {
      handoffs.push({ sourceInteraction, options });
    },
  });

  await service.handleLocalSyncButton(interaction);

  assert.equal(interaction.deferredUpdates, 1);
  assert.equal(interaction.edits.length, 0);
  assert.equal(PreviewModel.value.status, "applied");
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].sourceInteraction, interaction);
  assert.equal(handoffs[0].options.alreadyDeferred, true);
  assert.match(handoffs[0].options.content, /Sync complete/);
});

test("cancelling a preview replaces the console with Raid Status without writing", async () => {
  const discordId = "raid-sync-cancel-handoff-user";
  const userDoc = {
    discordId,
    language: "en",
    localSyncEnabled: true,
    autoManageEnabled: false,
    accounts: [],
  };
  const pendingJob = makeJob({ discordId });
  const PreviewModel = makePreviewModel(pendingJob);
  const handoffs = [];
  const interaction = {
    customId: `local-sync:cancel:${pendingJob.jobId}`,
    user: { id: discordId, username: "Aki" },
    deferredUpdates: 0,
    async deferUpdate() { this.deferredUpdates += 1; },
  };
  const service = createLocalSyncDiscordConsole({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: makeConsoleUserModel(userDoc),
    PreviewModel,
    openRaidStatusSession: async (sourceInteraction, options) => {
      handoffs.push({ sourceInteraction, options });
    },
  });

  await service.handleLocalSyncButton(interaction);

  assert.equal(interaction.deferredUpdates, 1);
  assert.equal(PreviewModel.value.status, "cancelled");
  assert.equal(handoffs.length, 1);
  assert.match(handoffs[0].options.content, /cancelled/);
});

test("global Local Sync buttons acknowledge quickly but reject a different Discord owner", async () => {
  const ownerJob = makeJob({ discordId: "preview-owner" });
  const replies = [];
  const interaction = {
    customId: `local-sync:apply:${ownerJob.jobId}`,
    user: { id: "other-user", username: "Other" },
    deferredUpdates: 0,
    async deferUpdate() { this.deferredUpdates += 1; },
    async followUp(payload) { replies.push(payload); },
  };
  const service = createLocalSyncDiscordConsole({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: makeConsoleUserModel({ discordId: "other-user", language: "en" }),
    PreviewModel: { findOne: () => ownerJob },
  });

  await service.handleLocalSyncButton(interaction);

  assert.equal(interaction.deferredUpdates, 1);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, 64);
  assert.match(replies[0].content, /different Discord account/);
});

test("Discord DM delivery renders the durable console and stores its receipt", async () => {
  const discordId = "raid-sync-dm-user";
  const userDoc = {
    discordId,
    language: "en",
    localSyncEnabled: true,
    autoManageEnabled: false,
    accounts: [],
  };
  const pendingJob = makeJob({ discordId });
  const PreviewModel = makePreviewModel(pendingJob);
  const sent = [];
  const targetUser = {
    id: discordId,
    username: "Aki",
    async send(payload) {
      sent.push(payload);
      return { id: "message-1", channelId: "dm-channel-1" };
    },
  };
  const service = createLocalSyncDiscordConsole({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: makeConsoleUserModel(userDoc),
    PreviewModel,
  });
  const previousBaseUrl = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  let outcome;
  try {
    outcome = await service.notifyPreviewReady({
      users: { fetch: async () => targetUser },
    }, {
      jobId: pendingJob.jobId,
      discordId,
      lang: "en",
    });
  } finally {
    if (previousBaseUrl == null) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  }

  assert.deepEqual(outcome, {
    delivered: true,
    channel: "dm",
    messageId: "message-1",
  });
  assert.equal(sent.length, 1);
  assert.ok(componentIds(sent[0]).includes(`local-sync:apply:${pendingJob.jobId}`));
  assert.equal(PreviewModel.value.deliveryChannelId, "dm-channel-1");
  assert.equal(PreviewModel.value.deliveryMessageId, "message-1");
});

function matchesFilter(doc, filter) {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") {
      if (!expected.some((branch) => matchesFilter(doc, branch))) return false;
      continue;
    }
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(expected, "$gt")) {
        if (!(Number(new Date(doc[key])) > Number(expected.$gt))) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(expected, "$lte")) {
        if (!(Number(new Date(doc[key])) <= Number(expected.$lte))) return false;
        continue;
      }
    }
    if (expected === null) {
      if (doc[key] != null) return false;
      continue;
    }
    if (expected instanceof Date) {
      if (Number(new Date(doc[key])) !== Number(expected)) return false;
      continue;
    }
    if (doc[key] !== expected) return false;
  }
  return true;
}

function makePreviewModel(initialJob) {
  let job = { ...initialJob };
  return {
    get value() { return job; },
    findOne(filter) {
      return matchesFilter(job, filter) ? { ...job } : null;
    },
    async findOneAndUpdate(filter, update) {
      if (!matchesFilter(job, filter)) return null;
      job = { ...job, ...(update?.$set || {}) };
      return { ...job };
    },
  };
}

test("Discord apply claims a preview atomically and is idempotent", async () => {
  const job = makeJob();
  const PreviewModel = makePreviewModel(job);
  const writes = [];
  const userDoc = {
    discordId: "u1",
    localSyncEnabled: true,
    autoManageEnabled: false,
    lastLocalSyncToken: null,
    accounts: [{
      accountName: "Roster",
      characters: [{
        name: "Aki",
        class: "Artist",
        itemLevel: 1750,
        isGoldEarner: true,
        assignedRaids: {},
      }],
    }],
  };
  const UserModel = {
    findOne() {
      return { select: () => ({ lean: async () => userDoc }) };
    },
    async findOneAndUpdate() {
      return userDoc;
    },
    async updateOne() {
      return { matchedCount: 1 };
    },
  };
  const deps = {
    PreviewModel,
    UserModel,
    applyRaidSetForDiscordId: async (args) => {
      writes.push(args);
      return { matched: true, updated: true, displayName: "Aki" };
    },
  };

  const first = await applyPreviewJob(job.jobId, "u1", deps);
  const second = await applyPreviewJob(job.jobId, "u1", deps);

  assert.equal(first.ok, true);
  assert.equal(first.state, "applied");
  assert.equal(first.result.applied.length, 1);
  assert.equal(PreviewModel.value.status, "applied");
  assert.equal(writes.length, 1);
  assert.equal(second.ok, false);
  assert.equal(second.state, "applied");
  assert.equal(writes.length, 1, "a second click must not write again");
});

test("a stale applying lease can be reclaimed after a bot restart", async () => {
  const nowMs = Date.now();
  const job = makeJob({
    status: "applying",
    applyingAt: new Date(nowMs - PREVIEW_APPLY_LEASE_MS - 1),
  });
  const PreviewModel = makePreviewModel(job);
  const userDoc = {
    discordId: "u1",
    localSyncEnabled: true,
    autoManageEnabled: false,
    lastLocalSyncToken: null,
    accounts: [{
      accountName: "Roster",
      characters: [{
        name: "Aki",
        class: "Artist",
        itemLevel: 1750,
        isGoldEarner: true,
        assignedRaids: {},
      }],
    }],
  };
  const writes = [];

  const outcome = await applyPreviewJob(job.jobId, "u1", {
    PreviewModel,
    UserModel: makeConsoleUserModel(userDoc),
    applyRaidSetForDiscordId: async (args) => {
      writes.push(args);
      return { matched: true, updated: true, displayName: "Aki" };
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.state, "applied");
  assert.equal(writes.length, 1);
  assert.equal(PreviewModel.value.status, "applied");
  assert.equal(PreviewModel.value.applyingAt, null);
});

test("an active applying lease cannot be stolen or cancelled", async () => {
  const nowMs = Date.now();
  const job = makeJob({
    status: "applying",
    applyingAt: new Date(nowMs),
  });
  const PreviewModel = makePreviewModel(job);
  let writes = 0;

  const outcome = await applyPreviewJob(job.jobId, "u1", {
    PreviewModel,
    UserModel: makeConsoleUserModel({ discordId: "u1", localSyncEnabled: true }),
    applyRaidSetForDiscordId: async () => {
      writes += 1;
      return { matched: true, updated: true };
    },
  });
  const cancelled = await cancelPreviewJob(job.jobId, "u1", {
    PreviewModel,
    nowMs,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.state, "applying");
  assert.equal(writes, 0);
  assert.equal(cancelled, null);
  assert.equal(PreviewModel.value.status, "applying");
});

test("a transient write error stays pending and succeeds on retry", async () => {
  const job = makeJob({ projection: { changes: { chars: 1, raids: 1, gates: 1 } } });
  const PreviewModel = makePreviewModel(job);
  const userDoc = {
    discordId: "u1",
    localSyncEnabled: true,
    autoManageEnabled: false,
    lastLocalSyncToken: null,
    accounts: [{
      accountName: "Roster",
      characters: [{
        name: "Aki",
        class: "Artist",
        itemLevel: 1750,
        isGoldEarner: true,
        assignedRaids: {},
      }],
    }],
  };
  let attempts = 0;
  const deps = {
    PreviewModel,
    UserModel: makeConsoleUserModel(userDoc),
    applyRaidSetForDiscordId: async () => {
      attempts += 1;
      if (attempts === 1) return null;
      return { matched: true, updated: true, displayName: "Aki" };
    },
  };

  const first = await applyPreviewJob(job.jobId, "u1", deps);
  assert.equal(first.ok, false);
  assert.equal(first.state, "pending");
  assert.equal(first.retryable, true);
  assert.equal(first.result.rejected[0].reason, "write_error");
  assert.equal(PreviewModel.value.status, "pending");
  assert.equal(PreviewModel.value.failureReason, "write_error");
  assert.equal(PreviewModel.value.projection, null);
  assert.equal(PreviewModel.value.applyingAt, null);

  const second = await applyPreviewJob(job.jobId, "u1", deps);
  assert.equal(second.ok, true);
  assert.equal(second.state, "applied");
  assert.equal(attempts, 2);
  assert.equal(PreviewModel.value.status, "applied");
});

test("Refresh on an old console loads the newest actionable preview", async () => {
  const discordId = "raid-sync-refresh-latest-user";
  const oldJob = makeJob({
    discordId,
    jobId: "aaaaaaaa-2222-4333-8444-555555555555",
    status: "superseded",
  });
  const latestJob = makeJob({
    discordId,
    jobId: "bbbbbbbb-2222-4333-8444-555555555555",
  });
  const userDoc = {
    discordId,
    language: "en",
    localSyncEnabled: true,
    autoManageEnabled: false,
    accounts: [],
  };
  const PreviewModel = {
    findOne(filter) {
      if (filter.jobId === oldJob.jobId) return oldJob;
      if (filter.discordId === discordId && !filter.jobId) return latestJob;
      return null;
    },
  };
  const interaction = {
    customId: `local-sync:refresh:${oldJob.jobId}`,
    user: { id: discordId, username: "Aki" },
    deferredUpdates: 0,
    edits: [],
    async deferUpdate() { this.deferredUpdates += 1; },
    async editReply(payload) { this.edits.push(payload); },
  };
  const service = createLocalSyncDiscordConsole({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: makeConsoleUserModel(userDoc),
    PreviewModel,
    openRaidStatusSession: async () => {
      throw new Error("latest pending preview must stay in the console");
    },
  });
  const previousBaseUrl = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  try {
    await service.handleLocalSyncButton(interaction);
  } finally {
    if (previousBaseUrl == null) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  }

  assert.equal(interaction.deferredUpdates, 1);
  assert.equal(interaction.edits.length, 1);
  assert.ok(componentIds(interaction.edits[0]).includes(
    `local-sync:apply:${latestJob.jobId}`
  ));
});

test("a cleaned-up preview button falls through to a fresh raid-status session", async () => {
  const discordId = "raid-sync-cleaned-job-user";
  const userDoc = {
    discordId,
    language: "en",
    localSyncEnabled: true,
    autoManageEnabled: false,
    accounts: [],
  };
  const handoffs = [];
  const interaction = {
    customId: "local-sync:refresh:deleted-job-id",
    user: { id: discordId, username: "Aki" },
    deferredUpdates: 0,
    async deferUpdate() { this.deferredUpdates += 1; },
  };
  const service = createLocalSyncDiscordConsole({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags: { Ephemeral: 64 },
    UI,
    User: makeConsoleUserModel(userDoc),
    PreviewModel: { findOne: () => null },
    openRaidStatusSession: async (sourceInteraction, options) => {
      handoffs.push({ sourceInteraction, options });
    },
  });

  await service.handleLocalSyncButton(interaction);

  assert.equal(interaction.deferredUpdates, 1);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].sourceInteraction, interaction);
  assert.equal(handoffs[0].options.alreadyDeferred, true);
  assert.equal(handoffs[0].options.content, null);
});

test("console header leads every data line with an icon and keeps the expiry as a labelled value", () => {
  const render = (job) => buildLocalSyncConsolePayload({
    job,
    summary: { changes: { chars: 1, raids: 1, gates: 2 } },
    readerUrl: "https://example.test/sync?token=x",
    activeScope: "full",
    lang: "vi",
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
    formatGold: (value) => `${value} G`,
  }).embeds[0].toJSON().description;

  const pending = render(makeJob()).split("\n");
  assert.match(pending[0], /^🌐 \*\*Phạm vi:\*\* /);
  assert.match(pending[1], /^⏳ \*\*Trạng thái:\*\* Chờ xác nhận$/);
  // Discord renders <t:…:R> in the viewer's own language, so it must not
  // sit inside a sentence · after a label the English fragment reads as data.
  assert.match(pending[2], /^🕐 \*\*Hết hạn:\*\* <t:\d+:R>$/);
  // The "what to do next" sentence stays icon-free, like the /raid-status
  // views it borrows from.
  assert.doesNotMatch(pending[3], /^[🌐⏳🕐]/);

  // The status icon tracks the state rather than being decoration.
  assert.match(render(makeJob({ status: "applied" })).split("\n")[1], /^✅ /);
  assert.match(render(makeJob({ status: "failed", failureReason: "apply_failed" })).split("\n")[1], /^⚠️ /);
  assert.match(render(makeJob({ status: "cancelled" })).split("\n")[1], /^✖️ /);

  // Only a live pending preview carries an expiry line.
  const applied = render(makeJob({ status: "applied" }));
  assert.doesNotMatch(applied, /Hết hạn/);
});
