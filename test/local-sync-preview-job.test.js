process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const { PassThrough } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPreviewJob,
  mintToken,
  normalizePreviewDeltas,
  resolvePreviewJobState,
} = require("../bot/services/local-sync");
const {
  createPreviewJobEndpoint,
} = require("../bot/services/local-sync/http/endpoints/preview-job-endpoint");
const {
  createLocalSyncApiHandlers,
} = require("../bot/app/local-sync-web");

function validDelta(overrides = {}) {
  return {
    boss: "Brelshaza, Ember in the Ashes",
    difficulty: "Normal",
    cleared: true,
    charName: "Aki",
    lastClearMs: Date.now(),
    ...overrides,
  };
}

function makeReq(token, body) {
  const req = new PassThrough();
  req.method = "POST";
  req.headers = { authorization: `Bearer ${token}` };
  process.nextTick(() => req.end(JSON.stringify(body)));
  return req;
}

function makeRes() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body || "";
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    },
  };
}

test("web API exposes preview handoff but not the legacy direct-write route", () => {
  const handlers = createLocalSyncApiHandlers({ User: {} });

  assert.equal(typeof handlers["POST /api/local-sync/preview-job"], "function");
  assert.equal(handlers["POST /api/raid-sync"], undefined);
});

test("preview delta normalization keeps only safe cleared rows", () => {
  const result = normalizePreviewDeltas([
    validDelta({ boss: `  ${"x".repeat(300)}  ` }),
    validDelta({ cleared: false }),
    validDelta({ cleared: "true" }),
    validDelta({ charName: "" }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].boss.length, 256);
  assert.equal(result[0].charName, "Aki");
  assert.equal(result[0].cleared, true);
});

test("creating a preview supersedes the previous pending job", async () => {
  const calls = [];
  const PreviewModel = {
    async updateMany(filter, update) {
      calls.push({ kind: "updateMany", filter, update });
    },
    async create(doc) {
      calls.push({ kind: "create", doc });
      return doc;
    },
  };

  const job = await createPreviewJob({
    discordId: "u1",
    scope: "full",
    deltas: [validDelta()],
    token: "secret-link",
    nowMs: 1_000,
  }, { PreviewModel });

  assert.deepEqual(calls[0], {
    kind: "updateMany",
    filter: { discordId: "u1", status: "pending" },
    update: { $set: { status: "superseded", failureReason: "newer_preview" } },
  });
  assert.match(job.jobId, /^[0-9a-f-]{36}$/i);
  assert.equal(job.deltas.length, 1);
  assert.equal(job.tokenFingerprint.length, 64);
  assert.equal(Number(job.expiresAt), 1_000 + 2 * 60 * 60 * 1000);
  assert.equal(resolvePreviewJobState(job, 2_000), "pending");
  assert.equal(resolvePreviewJobState(job, Number(job.expiresAt) + 1), "expired");
});

test("preview-job endpoint stores deltas and delivers a Discord confirmation", async () => {
  const token = mintToken("u1", undefined, "vi");
  const created = [];
  const notifications = [];
  const PreviewModel = {
    async updateMany() {},
    async create(doc) {
      created.push(doc);
      return doc;
    },
  };
  const User = {
    findOne() {
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              localSyncEnabled: true,
              autoManageEnabled: false,
              lastLocalSyncToken: token,
              lastLocalSyncTokenExpAt: 9_999_999_999,
              language: "vi",
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
            }),
          };
        },
      };
    },
  };
  const handler = createPreviewJobEndpoint({
    User,
    PreviewModel,
    notifyPreviewReady: async (payload) => {
      notifications.push(payload);
      return { delivered: true, channel: "dm" };
    },
  });
  const res = makeRes();

  await handler(makeReq(token, { deltas: [validDelta()] }), res, { query: {} });

  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.deepEqual(res.json().delivery, { delivered: true, channel: "dm" });
  assert.equal(created.length, 1);
  assert.equal(created[0].discordId, "u1");
  assert.equal(created[0].scope, "full");
  assert.deepEqual(created[0].projection.changes, { chars: 1, raids: 1, gates: 1 });
  assert.deepEqual(created[0].projection.changeDetails[0].raids, [
    { raidKey: "armoche", modeKey: "normal", gates: ["G1"] },
  ]);
  assert.deepEqual(notifications, [{
    jobId: created[0].jobId,
    discordId: "u1",
    lang: "vi",
  }]);
});

test("preview-job endpoint stores the job when Discord DMs are unavailable", async () => {
  const token = mintToken("u2", undefined, "en");
  const PreviewModel = {
    async updateMany() {},
    async create(doc) { return doc; },
  };
  const User = {
    findOne() {
      return {
        select: () => ({
          lean: async () => ({
            discordId: "u2",
            localSyncEnabled: true,
            lastLocalSyncToken: token,
            lastLocalSyncTokenExpAt: 9_999_999_999,
            language: "en",
            accounts: [],
          }),
        }),
      };
    },
  };
  const handler = createPreviewJobEndpoint({
    User,
    PreviewModel,
    notifyPreviewReady: async () => {
      throw new Error("Cannot send messages to this user");
    },
  });
  const res = makeRes();

  await handler(makeReq(token, { deltas: [validDelta()] }), res, { query: {} });

  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().delivery.delivered, false);
  assert.equal(res.json().delivery.channel, "stored");
  assert.match(res.json().delivery.error, /Cannot send messages/);
});
