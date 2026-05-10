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
 * Payload JSON: { discordId, iat, exp, nonce }. Signature: HMAC-SHA256 over
 * the payload segment with a secret from env. Verification is constant-
 * time (timingSafeEqual) so a malformed token can't leak length info.
 *
 * Secret rotation: bump LOCAL_SYNC_TOKEN_SECRET in env; all in-flight
 * tokens invalidate immediately. No client-side TTL refresh path - if a
 * token expires, the user runs /raid-auto-manage action:local-on again
 * and the success embed mints a fresh one.
 */

const DEFAULT_TTL_SEC = 15 * 60; // 15 minutes - balances "user reads DM, drops file, hits sync" against tight anti-replay window

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
 * to 15 minutes - tight enough that a leaked URL has a small replay
 * window, generous enough for "user opens DM, opens link, drops file,
 * hits sync" without rushing.
 *
 * Optional `lang` (Phase i18n): when present, encoded in the payload so
 * the web companion can render in the user's preferred language without
 * a separate round-trip. Stale at most 15 minutes (token TTL) - if user
 * runs /raid-language after mint and reuses the URL, the page renders
 * in the old lang until a fresh mint via /raid-auto-manage local-on.
 *
 * Throws if the secret env var is unset - callers should let this
 * propagate to the user as a "feature not configured" error rather than
 * silently fall back to insecure behavior.
 */
function mintToken(discordId, ttlSec = DEFAULT_TTL_SEC, lang = null, profile = null) {
  if (!discordId || typeof discordId !== "string") {
    throw new Error("[local-sync/tokens] mintToken: discordId required");
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    discordId,
    iat: now,
    exp: now + Math.max(60, Number(ttlSec) || DEFAULT_TTL_SEC),
    nonce: crypto.randomBytes(8).toString("hex"),
  };
  if (typeof lang === "string" && lang) payload.lang = lang;
  // Profile fields are display-only - the web companion renders avatar +
  // name in the auth-status line so the raw Discord snowflake doesn't
  // leak in the page UI. Backend auth still uses `discordId` for ownership
  // checks; the profile fields are NEVER trusted server-side.
  if (profile && typeof profile === "object") {
    if (typeof profile.username === "string" && profile.username) payload.username = profile.username;
    if (typeof profile.avatarUrl === "string" && profile.avatarUrl) payload.avatarUrl = profile.avatarUrl;
  }
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

function isCurrentStoredToken(userDoc, token, nowSec = Math.floor(Date.now() / 1000)) {
  // Backward compatibility for links minted before token persistence existed.
  // Once a stored token exists, rotation/reset can hard-revoke older URLs.
  if (!userDoc?.lastLocalSyncToken) return true;
  if (userDoc.lastLocalSyncToken !== token) return false;
  const expAt = Number(userDoc.lastLocalSyncTokenExpAt) || 0;
  return !expAt || expAt >= nowSec;
}

/**
 * Mint + persist on User. Used by /raid-auto-manage local-on,
 * /raid-status local-sync "New link" button, stuck-nudge button -
 * any flow that explicitly produces a fresh token. Replaces any
 * existing stored token. Endpoints require this current stored token when
 * one exists, so rotation/reset hard-revokes older URLs immediately.
 *
 * Returns the minted token string. Throws on mint failure (env unset)
 * or DB update failure.
 */
async function rotateLocalSyncToken(discordId, lang, deps = {}) {
  const UserModel = deps?.UserModel;
  if (!UserModel) throw new Error("[local-sync/tokens] rotateLocalSyncToken: UserModel required");
  const token = mintToken(discordId, undefined, lang, deps?.profile || null);
  const expAt = Math.floor(Date.now() / 1000) + DEFAULT_TTL_SEC;
  await UserModel.findOneAndUpdate(
    { discordId },
    { $set: { lastLocalSyncToken: token, lastLocalSyncTokenExpAt: expAt } },
    { new: true }
  );
  return token;
}

/**
 * Resume helper: returns the stored token if it still has > 60s left,
 * else mints fresh + saves + returns. Used by /raid-status default
 * "Open Web Companion" button - so a returning user keeps the same
 * URL across multiple /raid-status calls within the 15-min TTL,
 * making bookmarks / open browser tabs continue to work.
 *
 * The 60s safety buffer prevents handing out a token that's about to
 * expire mid-page-load (user clicks button, browser fetches page,
 * token is dead by the time the file picker opens).
 */
async function getOrMintLocalSyncToken(discordId, lang, deps = {}) {
  const UserModel = deps?.UserModel;
  if (!UserModel) throw new Error("[local-sync/tokens] getOrMintLocalSyncToken: UserModel required");
  const stored = await UserModel.findOne({ discordId })
    .select("lastLocalSyncToken lastLocalSyncTokenExpAt")
    .lean();
  const now = Math.floor(Date.now() / 1000);
  if (stored?.lastLocalSyncToken && Number(stored.lastLocalSyncTokenExpAt) > now + 60) {
    return stored.lastLocalSyncToken;
  }
  return rotateLocalSyncToken(discordId, lang, { UserModel, profile: deps?.profile || null });
}

/**
 * Extract a display-only profile (username + avatar URL) from a discord.js
 * User object so callers can pass it through to mintToken without each
 * one knowing the discord.js shape. Returns null if the user object is
 * missing - mintToken treats that as "no profile, no UI swap".
 *
 * `globalName` is preferred over `username` (the new Discord identity
 * system surfaces the prettier display name there). `displayAvatarURL`
 * with size=64 keeps the URL short - the web only renders a 24-32px
 * avatar inline anyway.
 */
function extractProfileFromUser(user) {
  if (!user) return null;
  const username = user.globalName || user.username || null;
  let avatarUrl = null;
  if (typeof user.displayAvatarURL === "function") {
    try {
      avatarUrl = user.displayAvatarURL({ size: 64, extension: "webp" });
    } catch {
      avatarUrl = null;
    }
  } else if (typeof user.avatar === "string" && user.avatar) {
    avatarUrl = user.avatar;
  }
  if (!username && !avatarUrl) return null;
  return { username, avatarUrl };
}

module.exports = {
  mintToken,
  verifyToken,
  isCurrentStoredToken,
  rotateLocalSyncToken,
  getOrMintLocalSyncToken,
  extractProfileFromUser,
  DEFAULT_TTL_SEC,
};
