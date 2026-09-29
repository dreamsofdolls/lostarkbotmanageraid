process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const { PassThrough } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

const { mintToken } = require("../bot/services/local-sync");
const {
  createApplyEndpoint,
} = require("../bot/services/local-sync/http/endpoints/apply-endpoint");

const JOB_ID = "11111111-2222-4333-8444-555555555555";

function makeReq(token, body) {
  const req = new PassThrough();
  req.method = "POST";
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  process.nextTick(() => req.end(JSON.stringify(body)));
  return req;
}

function makeRes() {
  return {
    status: null,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body || "";
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    },
  };
}

function makeUserModel(userDoc) {
  return {
    findOne() {
      return { select: () => ({ lean: async () => userDoc }) };
    },
  };
}

function makePreviewModel(job) {
  return {
    findOne(filter) {
      return job && job.jobId === filter.jobId && job.discordId === filter.discordId
        ? { ...job }
        : null;
    },
  };
}

// A Full Local Sync owner "u1" holding `token`, with one pending Full job.
function setup({
  scope = "full",
  userOverrides = {},
  job = { jobId: JOB_ID, discordId: "u1", scope: "full", status: "pending" },
  applyPreviewJob = async () => ({ ok: true, state: "applied", result: { applied: [], rejected: [] } }),
} = {}) {
  const token = mintToken("u1", undefined, "en", null, scope);
  const applyCalls = [];
  const handler = createApplyEndpoint({
    User: makeUserModel({
      discordId: "u1",
      localSyncEnabled: true,
      autoManageEnabled: false,
      lastLocalSyncToken: token,
      lastLocalSyncTokenExpAt: 9_999_999_999,
      ...userOverrides,
    }),
    PreviewModel: makePreviewModel(job),
    applyPreviewJob: async (...args) => {
      applyCalls.push(args);
      return applyPreviewJob(...args);
    },
    log: { error() {} },
  });
  async function post(body = { jobId: JOB_ID }, authToken = token) {
    const res = makeRes();
    await handler(makeReq(authToken, body), res);
    return res;
  }
  return { post, applyCalls };
}

test("apply rejects a request without a valid link before touching the job", async () => {
  const { post, applyCalls } = setup();

  const missing = await post({ jobId: JOB_ID }, null);
  const forged = await post({ jobId: JOB_ID }, "not-a-token");

  assert.equal(missing.status, 401);
  assert.equal(forged.status, 401);
  assert.equal(applyCalls.length, 0);
});

test("apply needs a jobId", async () => {
  const { post, applyCalls } = setup();

  const res = await post({});

  assert.equal(res.status, 400);
  assert.equal(res.json().error, "jobId required");
  assert.equal(applyCalls.length, 0);
});

test("apply refuses a disabled scope and a revoked link", async () => {
  const disabled = setup({ userOverrides: { localSyncEnabled: false } });
  const revoked = setup({ userOverrides: { lastLocalSyncToken: "a-newer-link" } });

  const disabledRes = await disabled.post();
  const revokedRes = await revoked.post();

  assert.equal(disabledRes.status, 409);
  assert.equal(revokedRes.status, 401);
  assert.match(revokedRes.json().error, /revoked/);
  assert.equal(disabled.applyCalls.length + revoked.applyCalls.length, 0);
});

test("apply cannot reach another owner's job or a job from the other scope", async () => {
  const otherOwner = setup({
    job: { jobId: JOB_ID, discordId: "u2", scope: "full", status: "pending" },
  });
  const soloLinkOnFullJob = setup({
    scope: "solo",
    userOverrides: { autoManageEnabled: true },
  });

  const otherRes = await otherOwner.post();
  const scopeRes = await soloLinkOnFullJob.post();

  assert.equal(otherRes.status, 404);
  assert.equal(otherRes.json().state, "missing");
  assert.equal(scopeRes.status, 404);
  assert.equal(otherOwner.applyCalls.length + soloLinkOnFullJob.applyCalls.length, 0);
});

test("an applied job reports only the caller's own writes", async () => {
  const { post, applyCalls } = setup({
    applyPreviewJob: async () => ({
      ok: true,
      state: "applied",
      result: {
        applied: [
          { charName: "Aki", raidKey: "armoche" },
          { charName: "aki", raidKey: "kazeros" },
          { charName: "Bao", raidKey: "armoche" },
          { charName: "Bao", raidKey: "armoche", propagated: true, discordId: "u2" },
        ],
        rejected: [
          { charName: "Cato", reason: "no_char" },
          { charName: "Aki", reason: "write_error" },
          { charName: "Dia", reason: "no_char", propagated: true, discordId: "u3" },
        ],
      },
    }),
  });

  const res = await post();

  assert.equal(res.status, 200);
  assert.deepEqual(applyCalls, [[JOB_ID, "u1"]]);
  assert.deepEqual(res.json(), {
    ok: true,
    state: "applied",
    retryable: false,
    written: { raids: 3, chars: 2 },
    rejected: 1,
  });
  assert.doesNotMatch(res.body, /u2|u3/);
});

test("a job another request already applied still reads as done", async () => {
  const { post } = setup({
    applyPreviewJob: async () => ({
      ok: false,
      state: "applied",
      job: { result: { applied: [{ charName: "Aki" }], rejected: [] } },
    }),
  });

  const res = await post();

  assert.equal(res.status, 200);
  assert.equal(res.json().ok, true);
  assert.deepEqual(res.json().written, { raids: 1, chars: 1 });
});

test("a retryable write error keeps the job pending for the same jobId", async () => {
  const { post } = setup({
    applyPreviewJob: async () => ({
      ok: false,
      state: "pending",
      retryable: true,
      result: {
        applied: [{ charName: "Aki" }],
        rejected: [{ charName: "Aki", reason: "write_error" }],
      },
    }),
  });

  const res = await post();

  assert.equal(res.status, 200);
  assert.equal(res.json().ok, false);
  assert.equal(res.json().state, "pending");
  assert.equal(res.json().retryable, true);
  assert.equal(res.json().rejected, 0);
});

test("an apply that throws answers 500 without leaking the error", async () => {
  const { post } = setup({
    applyPreviewJob: async () => {
      throw new Error("mongo detail");
    },
  });

  const res = await post();

  assert.equal(res.status, 500);
  assert.deepEqual(res.json(), { ok: false, error: "apply failed" });
});
