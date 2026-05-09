"use strict";

const crypto = require("node:crypto");

/**
 * JWT-style HMAC tokens used to bridge Discord identity into the web
 * companion. Format intentionally minimal so we don't pull in
 * jsonwebtoken or jose - this is internal-only short-lived auth, not a
 * federated standard. Two base64url segments joined by `.`:
 *
 *   <payload-b64url>.<signature-b64url>
 *
 * Payload JSON: { discordId, iat, exp }. Signature: HMAC-SHA256 over
 * the payload segment with a secret from env. Verification is constant-
 * time (timingSafeEqual) so a malformed token can't leak length info.
 *
 * Secret rotation: bump LOCAL_SYNC_TOKEN_SECRET in env; all in-flight
 * tokens invalidate immediately. No client-side TTL refresh path - if a
 * token expires, the user runs /raid-auto-manage action:local-on again
 * and the success embed mints a fresh one.
 */

const DEFAULT_TTL_SEC = 30 * 60; // 30 minutes - enough for the user to read the DM, drop the file, hit sync

function getSecret() {
  const raw = process.env.LOCAL_SYNC_TOKEN_SECRET;
  if (!raw || raw.length < 16) {
    // Refuse to mint with a weak/missing secret - silent fallback to a
    // dev-default would let production deploys ship insecure tokens.
    throw new Error(
      "[local-sync/tokens] LOCAL_SYNC_TOKEN_SECRET env var is missing or too short (need >= 16 chars). " +
        "Set it in your Railway / .env config before enabling local-sync."
    );
  }
  return raw;
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(str) {
  const pad = str.length % 4 === 2 ? "==" : str.length % 4 === 3 ? "=" : "";
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadB64) {
  const mac = crypto.createHmac("sha256", getSecret());
  mac.update(payloadB64);
  return base64url(mac.digest());
}

/**
 * Mint a token for the given Discord user. `ttlSec` is optional; defaults
 * to 30 minutes which is the safe upper bound for "user opens DM, opens
 * link, drops file, hits sync".
 *
 * Throws if the secret env var is unset - callers should let this
 * propagate to the user as a "feature not configured" error rather than
 * silently fall back to insecure behavior.
 */
function mintToken(discordId, ttlSec = DEFAULT_TTL_SEC) {
  if (!discordId || typeof discordId !== "string") {
    throw new Error("[local-sync/tokens] mintToken: discordId required");
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = { discordId, iat: now, exp: now + Math.max(60, Number(ttlSec) || DEFAULT_TTL_SEC) };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify + parse a token. Returns `{ ok: true, payload }` on success,
 * `{ ok: false, reason }` on any failure mode. Reasons:
 *   - "malformed"  - couldn't split or base64 decode
 *   - "signature"  - HMAC mismatch (forged or wrong secret)
 *   - "expired"    - exp < now
 *   - "no_secret"  - env var unset (caught from getSecret throw)
 *
 * Constant-time signature compare to avoid timing oracles on the secret.
 */
function verifyToken(token) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadB64, sigB64] = parts;
  let expected;
  try {
    expected = sign(payloadB64);
  } catch (err) {
    return { ok: false, reason: "no_secret", error: err.message };
  }
  // Buffer compare lengths must match for timingSafeEqual; pad short
  // sigs to expected length so a forged short token still hits the
  // constant-time path.
  const sigBuf = Buffer.from(sigB64);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return { ok: false, reason: "signature" };
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: "signature" };
  }
  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "malformed" };
  }
  if (!payload.discordId || !payload.exp) {
    return { ok: false, reason: "malformed" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

module.exports = {
  mintToken,
  verifyToken,
  DEFAULT_TTL_SEC,
};
