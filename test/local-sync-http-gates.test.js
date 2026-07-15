process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const test = require("node:test");
const assert = require("node:assert/strict");

const { COMPANION_SCOPE, mintToken, verifyToken } = require("../bot/services/local-sync");
const { createJsonSender } = require("../bot/services/local-sync/http/json");
const {
  LOCAL_SYNC_DISABLED_ERROR,
  TOKEN_REVOKED_ERROR,
  guardHttpMethod,
  readVerifiedLocalSyncToken,
  requireCurrentLocalSyncUser,
} = require("../bot/services/local-sync/http/request-gates");

function makeReq({ method = "GET", token = null } = {}) {
  return {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
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

const send = createJsonSender({ methods: "GET, OPTIONS" });

test("local-sync HTTP gate handles preflight and method mismatch", () => {
  const optionsRes = makeRes();
  const postRes = makeRes();

  assert.equal(guardHttpMethod({ req: makeReq({ method: "OPTIONS" }), res: optionsRes, send, method: "GET" }), false);
  assert.equal(optionsRes.status, 204);
  assert.equal(optionsRes.body, "");

  assert.equal(guardHttpMethod({ req: makeReq({ method: "POST" }), res: postRes, send, method: "GET" }), false);
  assert.equal(postRes.status, 405);
  assert.deepEqual(postRes.json(), { ok: false, error: "method not allowed" });

  assert.equal(guardHttpMethod({ req: makeReq({ method: "GET" }), res: makeRes(), send, method: "GET" }), true);
});

test("local-sync HTTP gate verifies bearer tokens and query fallback", () => {
  const token = mintToken("u1");
  const bearerRes = makeRes();
  const queryRes = makeRes();
  const missingRes = makeRes();
  const invalidRes = makeRes();

  const bearerAuth = readVerifiedLocalSyncToken({
    req: makeReq({ token }),
    res: bearerRes,
    parsedUrl: { query: {} },
    send,
  });
  assert.equal(bearerAuth.token, token);
  assert.equal(bearerAuth.discordId, "u1");
  assert.equal(bearerAuth.payload.discordId, "u1");
  assert.equal(bearerAuth.scopeExplicit, true);

  const queryAuth = readVerifiedLocalSyncToken({
    req: makeReq(),
    res: queryRes,
    parsedUrl: { query: { token } },
    send,
  });
  assert.equal(queryAuth.discordId, "u1");
  assert.equal(queryAuth.token, token);

  assert.equal(readVerifiedLocalSyncToken({ req: makeReq(), res: missingRes, parsedUrl: { query: {} }, send }), null);
  assert.equal(missingRes.status, 401);
  assert.deepEqual(missingRes.json(), { ok: false, error: "missing token" });

  assert.equal(
    readVerifiedLocalSyncToken({ req: makeReq({ token: "not-a-token" }), res: invalidRes, parsedUrl: { query: {} }, send }),
    null
  );
  assert.equal(invalidRes.status, 401);
  assert.deepEqual(invalidRes.json(), { ok: false, error: "token malformed" });
});

test("local-sync HTTP gate enforces enabled mode and current stored token", () => {
  const token = mintToken("u1");
  const currentToken = mintToken("u1");
  const disabledRes = makeRes();
  const revokedRes = makeRes();

  assert.equal(requireCurrentLocalSyncUser({
    userDoc: { localSyncEnabled: false },
    token,
    res: disabledRes,
    send,
  }), false);
  assert.equal(disabledRes.status, 409);
  assert.deepEqual(disabledRes.json(), { ok: false, error: LOCAL_SYNC_DISABLED_ERROR });

  assert.equal(requireCurrentLocalSyncUser({
    userDoc: {
      localSyncEnabled: true,
      lastLocalSyncToken: currentToken,
      lastLocalSyncTokenExpAt: 9999999999,
    },
    token,
    res: revokedRes,
    send,
  }), false);
  assert.equal(revokedRes.status, 401);
  assert.deepEqual(revokedRes.json(), { ok: false, error: TOKEN_REVOKED_ERROR });

  assert.equal(requireCurrentLocalSyncUser({
    userDoc: { localSyncEnabled: true, lastLocalSyncToken: token, lastLocalSyncTokenExpAt: 9999999999 },
    token,
    res: makeRes(),
    send,
  }), true);
});

test("local-sync HTTP gate uses auto-sync state for a Solo-scoped token", () => {
  const token = mintToken("u1", undefined, null, null, COMPANION_SCOPE.solo);
  const payload = verifyToken(token).payload;
  const enabledRes = makeRes();
  const disabledRes = makeRes();

  assert.equal(requireCurrentLocalSyncUser({
    userDoc: {
      autoManageEnabled: true,
      localSyncEnabled: false,
      lastLocalSyncToken: token,
      lastLocalSyncTokenExpAt: 9999999999,
    },
    token,
    payload,
    scopeExplicit: true,
    res: enabledRes,
    send,
  }), true);

  assert.equal(requireCurrentLocalSyncUser({
    userDoc: { autoManageEnabled: false },
    token,
    payload,
    res: disabledRes,
    send,
  }), false);
  assert.equal(disabledRes.status, 409);
  assert.match(disabledRes.json().error, /auto-sync disabled/);
});

test("new scoped tokens cannot resurrect after their stored token is cleared", () => {
  const token = mintToken("u1", undefined, null, null, COMPANION_SCOPE.solo);
  const verified = verifyToken(token);
  const res = makeRes();

  assert.equal(requireCurrentLocalSyncUser({
    userDoc: { autoManageEnabled: true, lastLocalSyncToken: null },
    token,
    payload: verified.payload,
    scopeExplicit: verified.scopeExplicit,
    res,
    send,
  }), false);
  assert.equal(res.status, 401);
  assert.equal(res.json().error, TOKEN_REVOKED_ERROR);
});
