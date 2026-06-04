"use strict";

const crypto = require("node:crypto");

const DEFAULT_PROFILE_DEVICE_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mintProfileDeviceToken() {
  return base64url(crypto.randomBytes(32));
}

function hashProfileDeviceToken(token) {
  if (!token || typeof token !== "string") return "";
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function rotateLocalProfileSyncToken(discordId, deps = {}) {
  const UserModel = deps?.UserModel;
  if (!UserModel) {
    throw new Error("[local-sync/profile-device-token] UserModel required");
  }
  if (!discordId || typeof discordId !== "string") {
    throw new Error("[local-sync/profile-device-token] discordId required");
  }

  const token = mintProfileDeviceToken();
  const expAt = Math.floor(Date.now() / 1000) + DEFAULT_PROFILE_DEVICE_TTL_SEC;
  await UserModel.findOneAndUpdate(
    { discordId, localSyncEnabled: true },
    {
      $set: {
        localProfileSyncTokenHash: hashProfileDeviceToken(token),
        localProfileSyncTokenExpAt: expAt,
      },
    },
    { new: true }
  );
  return { token, expAt };
}

function isCurrentProfileDeviceToken(userDoc, token, nowSec = Math.floor(Date.now() / 1000)) {
  const expected = userDoc?.localProfileSyncTokenHash;
  if (!expected || !token) return false;
  if ((Number(userDoc?.localProfileSyncTokenExpAt) || 0) < nowSec) return false;
  const actual = hashProfileDeviceToken(token);
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

module.exports = {
  DEFAULT_PROFILE_DEVICE_TTL_SEC,
  hashProfileDeviceToken,
  isCurrentProfileDeviceToken,
  mintProfileDeviceToken,
  rotateLocalProfileSyncToken,
};
