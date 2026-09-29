process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const { PassThrough } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PREVIEW_APPLY_LEASE_MS,
  createPreviewJob,
  filterPartyDeltasBySourceDeltas,
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

// A Full Local Sync user whose stored token is `token`, owning only Aki.
function makeAkiUser(discordId, token) {
  return {
    findOne() {
      return {
        select: () => ({
          lean: async () => ({
            discordId,
            localSyncEnabled: true,
            lastLocalSyncToken: token,
            lastLocalSyncTokenExpAt: 9_999_999_999,
            accounts: [{
              accountName: "Roster",
              characters: [{ name: "Aki", class: "Artist", itemLevel: 1750, assignedRaids: {} }],
            }],
          }),
        }),
      };
    },
  };
}

test("web API stores and applies preview jobs but keeps no direct-write route", () => {
  const handlers = createLocalSyncApiHandlers({ User: {}, applyPreviewJob: async () => ({}) });

  assert.equal(typeof handlers["POST /api/local-sync/preview-job"], "function");
  assert.equal(typeof handlers["POST /api/local-sync/apply"], "function");
  assert.equal(handlers["POST /api/local-sync/preview-summary"], undefined);
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

test("party deltas must point back to the exact source encounter", () => {
  const source = normalizePreviewDeltas([validDelta()]);
  const matching = {
    ...source[0],
    charName: "Bao",
    sourceCharName: "Aki",
  };
  const wrongGateEvidence = {
    ...matching,
    boss: "Armoche, Sentinel of the Abyss",
  };
  const sourceItself = {
    ...matching,
    charName: "Aki",
  };

  assert.deepEqual(
    filterPartyDeltasBySourceDeltas(source, [matching, wrongGateEvidence, sourceItself]),
    [matching]
  );
});

test("creating a full preview stores bounded party evidence while Solo discards it", async () => {
  const created = [];
  const PreviewModel = {
    async updateMany() {},
    async create(doc) {
      created.push(doc);
      return doc;
    },
  };
  const source = validDelta();
  const partyDelta = {
    ...source,
    charName: "Bao",
    sourceCharName: source.charName,
  };

  const full = await createPreviewJob({
    discordId: "party-full",
    scope: "full",
    deltas: [source],
    partyDeltas: [partyDelta],
  }, { PreviewModel });
  const solo = await createPreviewJob({
    discordId: "party-solo",
    scope: "solo",
    deltas: [source],
    partyDeltas: [partyDelta],
  }, { PreviewModel });

  assert.equal(full.partyDeltas.length, 1);
  assert.equal(full.partyDeltas[0].sourceCharName, "Aki");
  assert.deepEqual(solo.partyDeltas, []);
  assert.equal(created.length, 2);
});

test("full preview rejects more than 15 targets for one source Gate", async () => {
  let wrote = false;
  const PreviewModel = {
    async updateMany() { wrote = true; },
    async create() { wrote = true; },
  };
  const source = validDelta();
  const partyDeltas = Array.from({ length: 16 }, (_, index) => ({
    ...source,
    charName: `Target${index}`,
    sourceCharName: source.charName,
  }));

  await assert.rejects(
    createPreviewJob({
      discordId: "party-overflow",
      scope: "full",
      deltas: [source],
      partyDeltas,
    }, { PreviewModel }),
    /too many party targets for one source Gate \(max 15\)/
  );
  assert.equal(wrote, false, "fan-out must fail before the preview reaches Mongo");
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

  assert.equal(calls[0].kind, "updateMany");
  assert.equal(calls[0].filter.discordId, "u1");
  assert.deepEqual(calls[0].filter.$or, [
    { status: "pending" },
    {
      status: "applying",
      applyingAt: { $lte: new Date(1_000 - PREVIEW_APPLY_LEASE_MS) },
    },
    { status: "applying", applyingAt: null },
  ]);
  assert.deepEqual(calls[0].update, {
    $set: {
      status: "superseded",
      failureReason: "newer_preview",
      applyingAt: null,
    },
  });
  assert.match(job.jobId, /^[0-9a-f-]{36}$/i);
  assert.equal(job.deltas.length, 1);
  assert.equal(job.tokenFingerprint.length, 64);
  assert.equal(Number(job.expiresAt), 1_000 + 2 * 60 * 60 * 1000);
  assert.equal(resolvePreviewJobState(job, 2_000), "pending");
  assert.equal(resolvePreviewJobState(job, Number(job.expiresAt) + 1), "expired");
});

test("applying previews recover after their lease expires", () => {
  const nowMs = 10_000_000;
  const base = {
    status: "applying",
    expiresAt: new Date(nowMs + 60_000),
  };

  assert.equal(resolvePreviewJobState({
    ...base,
    applyingAt: new Date(nowMs - PREVIEW_APPLY_LEASE_MS + 1),
  }, nowMs), "applying");
  assert.equal(resolvePreviewJobState({
    ...base,
    applyingAt: new Date(nowMs - PREVIEW_APPLY_LEASE_MS),
  }, nowMs), "pending");
  assert.equal(resolvePreviewJobState(base, nowMs), "pending");
  assert.equal(resolvePreviewJobState({
    ...base,
    applyingAt: new Date(nowMs - PREVIEW_APPLY_LEASE_MS),
    expiresAt: new Date(nowMs - 1),
  }, nowMs), "expired");
});

test("concurrent preview creation is serialized per Discord user", async () => {
  const events = [];
  const PreviewModel = {
    async updateMany() {
      events.push("update");
      await new Promise((resolve) => setImmediate(resolve));
    },
    async create(doc) {
      events.push("create");
      return doc;
    },
  };

  await Promise.all([
    createPreviewJob({
      discordId: "serialized-user",
      scope: "full",
      deltas: [validDelta()],
    }, { PreviewModel }),
    createPreviewJob({
      discordId: "serialized-user",
      scope: "full",
      deltas: [validDelta()],
    }, { PreviewModel }),
  ]);

  assert.deepEqual(events, ["update", "create", "update", "create"]);
});

test("preview-job endpoint stores the cleared deltas and answers with the job id", async () => {
  const token = mintToken("u1", undefined, "vi");
  const created = [];
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
  const handler = createPreviewJobEndpoint({ User, PreviewModel });
  const res = makeRes();

  await handler(makeReq(token, {
    deltas: [
      validDelta(),
      validDelta({ charName: "Ghost", cleared: "true" }),
    ],
  }), res, { query: {} });

  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().jobId, created[0].jobId);
  assert.equal(res.json().delivery, undefined);
  assert.equal(created.length, 1);
  assert.equal(created[0].discordId, "u1");
  assert.equal(created[0].scope, "full");
  assert.equal(created[0].deltas.length, 1);
  assert.deepEqual(created[0].projection.changes, { chars: 1, raids: 1, gates: 1 });
  assert.deepEqual(created[0].projection.changeDetails[0].raids, [
    { raidKey: "armoche", modeKey: "normal", gates: ["G1"] },
  ]);
});

test("preview-job endpoint logs a storage failure and answers 500 without the driver message", async () => {
  const token = mintToken("u3", undefined, "en");
  const errors = [];
  const PreviewModel = {
    async updateMany() {
      throw new Error("MongoServerSelectionError: connect ECONNREFUSED 10.0.0.5:27017");
    },
    async create() {
      assert.fail("create must not run after the supersede write failed");
    },
  };
  const handler = createPreviewJobEndpoint({
    User: makeAkiUser("u3", token),
    PreviewModel,
    log: {
      error(...args) { errors.push(args.join(" ")); },
      warn() {},
    },
  });
  const res = makeRes();

  await handler(makeReq(token, { deltas: [validDelta()] }), res, { query: {} });

  assert.equal(res.status, 500);
  assert.deepEqual(res.json(), { ok: false, error: "preview job failed" });
  assert.doesNotMatch(res.body, /ECONNREFUSED/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ECONNREFUSED/);
});

test("preview-job endpoint keeps a party fan-out rejection as a 400 with its message", async () => {
  const token = mintToken("u4", undefined, "en");
  const errors = [];
  let wrote = false;
  const PreviewModel = {
    async updateMany() { wrote = true; },
    async create() { wrote = true; },
  };
  const handler = createPreviewJobEndpoint({
    User: makeAkiUser("u4", token),
    PreviewModel,
    log: {
      error(...args) { errors.push(args.join(" ")); },
      warn() {},
    },
  });
  const res = makeRes();
  const source = validDelta();

  await handler(makeReq(token, {
    deltas: [source],
    partyDeltas: Array.from({ length: 16 }, (_, index) => ({
      ...source,
      charName: `Target${index}`,
      sourceCharName: source.charName,
    })),
  }), res, { query: {} });

  assert.equal(res.status, 400);
  assert.equal(res.json().ok, false);
  assert.match(res.json().error, /too many party targets for one source Gate \(max 15\)/);
  assert.equal(wrote, false);
  assert.deepEqual(errors, [], "a rejected request is not a server fault");
});

test("preview-job endpoint rejects more deltas than a preview job accepts", async () => {
  const token = mintToken("u6", undefined, "en");
  const handler = createPreviewJobEndpoint({ User: makeAkiUser("u6", token) });
  const res = makeRes();

  await handler(makeReq(token, {
    deltas: Array.from({ length: 513 }, () => validDelta()),
  }), res, { query: {} });

  assert.equal(res.status, 400);
  assert.deepEqual(res.json(), { ok: false, error: "too many deltas (max 512)" });
});
