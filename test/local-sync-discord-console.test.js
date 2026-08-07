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
  applyPreviewJob,
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

function matchesFilter(doc, filter) {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "expiresAt" && expected?.$gt) {
      if (!(Number(new Date(doc.expiresAt)) > Number(expected.$gt))) return false;
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
