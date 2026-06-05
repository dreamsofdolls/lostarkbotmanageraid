"use strict";

const {
  verifyToken,
  isCurrentStoredToken,
} = require("..");
const { extractBearerToken } = require("./json");

const LOCAL_SYNC_DISABLED_ERROR = "local-sync disabled - run /raid-auto-manage action:local-on to re-enable";
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
    discordId: verified.payload.discordId,
  };
}

function requireCurrentLocalSyncUser({ userDoc, token, res, send }) {
  if (!userDoc?.localSyncEnabled) {
    send(res, 409, {
      ok: false,
      error: LOCAL_SYNC_DISABLED_ERROR,
    });
    return false;
  }
  if (!isCurrentStoredToken(userDoc, token)) {
    send(res, 401, {
      ok: false,
      error: TOKEN_REVOKED_ERROR,
    });
    return false;
  }
  return true;
}

module.exports = {
  LOCAL_SYNC_DISABLED_ERROR,
  TOKEN_REVOKED_ERROR,
  guardHttpMethod,
  readVerifiedLocalSyncToken,
  requireCurrentLocalSyncUser,
};
