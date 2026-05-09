// HMAC-token mint/verify suite for the web-companion auth bridge.
// Pinning happy path + 4 failure modes (malformed / forged / expired /
// missing-secret) so the verify branch table is regression-guarded.
//
// Each test sets/clears the env var inline to avoid bleed across the
// suite (Node's --test runs files in parallel processes by default but
// individual tests within a file share the env).

process.env.RAID_MANAGER_ID = "test-manager";
process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const test = require("node:test");
const assert = require("node:assert/strict");

const { mintToken, verifyToken, TOKEN_DEFAULT_TTL_SEC } = require("../bot/services/local-sync");

test("mintToken + verifyToken roundtrip - returns payload with discordId / iat / exp", () => {
  const token = mintToken("user-123");
  const result = verifyToken(token);
  assert.equal(result.ok, true);
  assert.equal(result.payload.discordId, "user-123");
  assert.equal(typeof result.payload.iat, "number");
  assert.equal(typeof result.payload.exp, "number");
  // iat = now (within 2s drift), exp = iat + DEFAULT_TTL_SEC
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(result.payload.iat - now) <= 2);
  assert.equal(result.payload.exp, result.payload.iat + TOKEN_DEFAULT_TTL_SEC);
});

test("mintToken with custom ttl - exp reflects override", () => {
  const token = mintToken("user-123", 600);
  const result = verifyToken(token);
  assert.equal(result.ok, true);
  assert.equal(result.payload.exp - result.payload.iat, 600);
});

test("mintToken floor at 60s - sub-minute ttl clamps up", () => {
  const token = mintToken("user-123", 5);
  const result = verifyToken(token);
  assert.equal(result.ok, true);
  // 5 seconds clamps to 60 to avoid accidentally minting throwaway tokens
  // that expire before the user can finish reading the DM.
  assert.equal(result.payload.exp - result.payload.iat, 60);
});

test("verifyToken - rejects empty / non-string token as malformed", () => {
  assert.equal(verifyToken("").reason, "malformed");
  assert.equal(verifyToken(null).reason, "malformed");
  assert.equal(verifyToken(123).reason, "malformed");
  assert.equal(verifyToken("nodothere").reason, "malformed");
});

test("verifyToken - rejects forged signature with reason='signature'", () => {
  const token = mintToken("user-123");
  // Flip last char of signature - same length so the constant-time
  // compare still runs (no length-shortcut leak).
  const tampered = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
  const result = verifyToken(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "signature");
});

test("verifyToken - rejects payload tamper (signature mismatch)", () => {
  const token = mintToken("user-123");
  const [payloadB64, sigB64] = token.split(".");
  // Substitute a different payload but reuse the original sig - HMAC
  // mismatch should reject.
  const fakePayload = Buffer.from(JSON.stringify({ discordId: "evil-user", iat: 1, exp: 9999999999 }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const result = verifyToken(`${fakePayload}.${sigB64}`);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "signature");
});

test("verifyToken - expired token rejected with reason='expired'", () => {
  // Mint with TTL clamped to 60, then verify with a clock-skew override
  // by directly constructing an expired payload + signing with the real
  // secret so signature passes but exp < now.
  const crypto = require("node:crypto");
  const past = Math.floor(Date.now() / 1000) - 100;
  const payloadB64 = Buffer.from(JSON.stringify({ discordId: "u", iat: past - 60, exp: past }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = crypto
    .createHmac("sha256", process.env.LOCAL_SYNC_TOKEN_SECRET)
    .update(payloadB64)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const result = verifyToken(`${payloadB64}.${sig}`);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "expired");
});

test("mintToken - throws when secret env var missing", () => {
  const previous = process.env.LOCAL_SYNC_TOKEN_SECRET;
  delete process.env.LOCAL_SYNC_TOKEN_SECRET;
  try {
    assert.throws(() => mintToken("u1"), /LOCAL_SYNC_TOKEN_SECRET/);
  } finally {
    process.env.LOCAL_SYNC_TOKEN_SECRET = previous;
  }
});

test("mintToken - throws when secret too short (< 16 chars)", () => {
  const previous = process.env.LOCAL_SYNC_TOKEN_SECRET;
  process.env.LOCAL_SYNC_TOKEN_SECRET = "short";
  try {
    assert.throws(() => mintToken("u1"), /too short/);
  } finally {
    process.env.LOCAL_SYNC_TOKEN_SECRET = previous;
  }
});

test("mintToken - rejects empty discordId", () => {
  assert.throws(() => mintToken(""), /discordId required/);
  assert.throws(() => mintToken(null), /discordId required/);
});
