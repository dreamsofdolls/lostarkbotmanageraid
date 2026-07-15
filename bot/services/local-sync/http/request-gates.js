"use strict";

const {
  COMPANION_SCOPE,
  getTokenCompanionScope,
  isCompanionScopeEnabledForUser,
  verifyToken,
  isCurrentStoredToken,
} = require("..");
const { extractBearerToken } = require("./json");

const LOCAL_SYNC_DISABLED_ERROR = "local-sync disabled - run /raid-auto-manage action:local-on to re-enable";
const AUTO_SYNC_DISABLED_ERROR = "auto-sync disabled - re-enable Bible auto-sync before using the Solo companion";
const TOKEN_REVOKED_ERROR = "token revoked - open a new local-sync link";

function guardHttpMethod({ req, res, send, method }) {
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return false;
  }
  if (req.method !== method) {
    send(res, 405, { ok: false, error: "method not allowed" });
    return false;
  }
  return true;
}

function readVerifiedLocalSyncToken({ req, res, parsedUrl, send }) {
  const token = extractBearerToken(req, parsedUrl);
  if (!token) {
    send(res, 401, { ok: false, error: "missing token" });
    return null;
  }

  const verified = verifyToken(token);
  if (!verified.ok) {
    send(res, 401, { ok: false, error: `token ${verified.reason}` });
    return null;
  }

  return {
    token,
    payload: verified.payload,
    scopeExplicit: verified.scopeExplicit === true,
    discordId: verified.payload.discordId,
  };
}

function requireCurrentLocalSyncUser({
  userDoc,
  token,
  payload = null,
  scope = null,
  scopeExplicit = null,
  res,
  send,
}) {
  const companionScope = scope || getTokenCompanionScope(payload);
  if (!isCompanionScopeEnabledForUser(userDoc, companionScope)) {
    send(res, 409, {
      ok: false,
      error: companionScope === COMPANION_SCOPE.solo
        ? AUTO_SYNC_DISABLED_ERROR
        : LOCAL_SYNC_DISABLED_ERROR,
    });
    return false;
  }
  if (!isCurrentStoredToken(userDoc, token, undefined, {
    // Only pre-scope legacy links retain the migration-era fail-open path.
    // Every newly minted full/solo link must match the persisted token.
    allowMissingStoredToken: scopeExplicit !== true,
  })) {
    send(res, 401, {
      ok: false,
      error: TOKEN_REVOKED_ERROR,
    });
    return false;
  }
  return true;
}

module.exports = {
  AUTO_SYNC_DISABLED_ERROR,
  LOCAL_SYNC_DISABLED_ERROR,
  TOKEN_REVOKED_ERROR,
  guardHttpMethod,
  readVerifiedLocalSyncToken,
  requireCurrentLocalSyncUser,
};
