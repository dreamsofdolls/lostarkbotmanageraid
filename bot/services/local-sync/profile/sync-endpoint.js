"use strict";

const {
  verifyToken,
  isCurrentStoredToken,
  TOKEN_POST_SYNC_TTL_SEC,
  rotateLocalProfileSyncToken,
  hashProfileDeviceToken,
} = require("..");
const {
  createJsonSender,
  extractBearerToken,
  readJsonBody,
} = require("../http/json");

const {
  PROFILE_VERSION,
  MAX_BODY_BYTES,
  sanitizeSnapshotPayload,
} = require("./payload-sanitizer");

const {
  shouldPromoteSnapshot,
  buildSnapshotUpdate,
  upsertEncounterSummaries,
} = require("./storage");
const {
  rebuildFullSnapshotFromStoredSummaries,
  rebuildWeeklySnapshotFromStoredSummaries,
} = require("./summary-snapshot-builder");

function createProfileSessionEndpoint({ User, isDevUser = () => true }) {
  if (!User) throw new Error("[profile-session-endpoint] User model required");
  const send = createJsonSender({ methods: "POST, OPTIONS" });

  return async function handleProfileSession(req, res, parsedUrl) {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    const token = extractBearerToken(req, parsedUrl);
    if (!token) {
      send(res, 401, { ok: false, error: "missing token" });
      return;
    }
    const verified = verifyToken(token);
    if (!verified.ok) {
      send(res, 401, { ok: false, error: `token ${verified.reason}` });
      return;
    }
    const discordId = verified.payload.discordId;
    // Preview gate: only DEV_USER allowlist may mint a profile-sync token.
    if (!isDevUser(discordId)) {
      send(res, 403, { ok: false, error: "raid-profile is in preview" });
      return;
    }

    let userDoc;
    try {
      userDoc = await User.findOne({ discordId })
        .select("localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt")
        .lean();
    } catch (err) {
      console.error("[profile-session-endpoint] state read failed:", err?.message || err);
      send(res, 500, { ok: false, error: "state read failed" });
      return;
    }
    if (!userDoc?.localSyncEnabled) {
      send(res, 409, {
        ok: false,
        error: "local-sync disabled - run /raid-auto-manage action:local-on to re-enable",
      });
      return;
    }
    if (!isCurrentStoredToken(userDoc, token)) {
      send(res, 401, {
        ok: false,
        error: "token revoked - open a new local-sync link",
      });
      return;
    }

    try {
      const session = await rotateLocalProfileSyncToken(discordId, { UserModel: User });
      send(res, 200, {
        ok: true,
        discordId,
        profileToken: session.token,
        expSec: session.expAt,
      });
    } catch (err) {
      console.error("[profile-session-endpoint] token mint failed:", err?.message || err);
      send(res, 500, { ok: false, error: "profile token mint failed" });
    }
  };
}

function extractLocalSyncTokenHeader(req) {
  const raw = req?.headers?.["x-artist-local-sync-token"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return "";
  const token = value.trim();
  return token.length <= 4096 ? token : "";
}

async function shrinkLocalSyncTokenAfterProfileUpload({ User, discordId, localSyncToken }) {
  if (!localSyncToken) return null;
  const shrunkAt = Math.floor(Date.now() / 1000) + TOKEN_POST_SYNC_TTL_SEC;
  const result = await User.updateOne(
    { discordId, lastLocalSyncToken: localSyncToken },
    { $set: { lastLocalSyncTokenExpAt: shrunkAt } }
  );
  const matched = Number(result?.matchedCount ?? result?.n ?? result?.modifiedCount ?? 0);
  return matched > 0 ? shrunkAt : null;
}

function createRaidProfileSyncEndpoint({ User, RaidProfileSnapshot, RaidProfileEncounter = null, isDevUser = () => true }) {
  if (!User) throw new Error("[raid-profile-sync-endpoint] User model required");
  if (!RaidProfileSnapshot) {
    throw new Error("[raid-profile-sync-endpoint] RaidProfileSnapshot model required");
  }
  const send = createJsonSender({
    methods: "POST, OPTIONS",
    allowHeaders: "Authorization, Content-Type, X-Artist-Local-Sync-Token",
  });

  return async function handleRaidProfileSync(req, res) {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    const auth = req.headers["authorization"] || "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    const profileToken = match ? match[1].trim() : "";
    if (!profileToken) {
      send(res, 401, { ok: false, error: "missing profile token" });
      return;
    }
    const localSyncToken = extractLocalSyncTokenHeader(req);

    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (err) {
      send(res, err.status || 400, { ok: false, error: err.message || "bad body" });
      return;
    }

    let userDoc;
    try {
      userDoc = await User.findOne({ localProfileSyncTokenHash: hashProfileDeviceToken(profileToken) })
        .select("discordId localSyncEnabled localProfileSyncTokenHash localProfileSyncTokenExpAt accounts")
        .lean();
    } catch (err) {
      console.error("[raid-profile-sync-endpoint] profile token lookup failed:", err?.message || err);
      send(res, 500, { ok: false, error: "state read failed" });
      return;
    }
    if (!userDoc?.localSyncEnabled) {
      send(res, 409, {
        ok: false,
        error: "local-sync disabled - run /raid-auto-manage action:local-on to re-enable",
      });
      return;
    }
    if (!((Number(userDoc.localProfileSyncTokenExpAt) || 0) >= Math.floor(Date.now() / 1000))) {
      send(res, 401, { ok: false, error: "profile token expired" });
      return;
    }
    // Preview gate: reject profile uploads from outside the DEV_USER allowlist.
    if (!isDevUser(userDoc.discordId)) {
      send(res, 403, { ok: false, error: "raid-profile is in preview" });
      return;
    }

    let clean;
    try {
      clean = sanitizeSnapshotPayload(body, userDoc);
    } catch (err) {
      send(res, err.status || 400, { ok: false, error: err.message || "invalid profile payload" });
      return;
    }
    if (!clean.totals.characterCount || !clean.totals.encounterCount) {
      send(res, 200, {
        ok: true,
        skipped: "empty-profile",
        discordId: userDoc.discordId,
        totals: {
          ...clean.totals,
          encounterSummaries: clean.encounterSummaries?.length || 0,
        },
      });
      return;
    }

    let encounterWrite = { received: clean.encounterSummaries?.length || 0, upserted: 0, modified: 0 };
    let effectiveClean = clean;
    let extraRangeSnapshots = {};
    try {
      encounterWrite = await upsertEncounterSummaries({
        discordId: userDoc.discordId,
        summaries: clean.encounterSummaries,
        RaidProfileEncounter,
      });
      const rebuiltWeekly = await rebuildWeeklySnapshotFromStoredSummaries({
        discordId: userDoc.discordId,
        clean,
        userDoc,
        RaidProfileEncounter,
      });
      const rebuiltFull = rebuiltWeekly
        ? await rebuildFullSnapshotFromStoredSummaries({
            discordId: userDoc.discordId,
            clean,
            userDoc,
            RaidProfileEncounter,
          })
        : null;
      if (rebuiltFull?.totals?.characterCount && rebuiltFull?.totals?.encounterCount) {
        effectiveClean = rebuiltFull;
        if (rebuiltWeekly?.totals?.characterCount && rebuiltWeekly?.totals?.encounterCount) {
          extraRangeSnapshots = { weekly: rebuiltWeekly };
        }
      } else if (rebuiltWeekly?.totals?.characterCount && rebuiltWeekly?.totals?.encounterCount) {
        effectiveClean = rebuiltWeekly;
      }
    } catch (err) {
      console.error("[raid-profile-sync-endpoint] encounter summary save/rebuild failed:", err?.message || err);
      send(res, 500, { ok: false, error: "profile summary save failed" });
      return;
    }

    let promotePrimary;
    try {
      promotePrimary = await shouldPromoteSnapshot(effectiveClean, userDoc.discordId, RaidProfileSnapshot);
    } catch (err) {
      console.error("[raid-profile-sync-endpoint] existing snapshot read failed:", err?.message || err);
      send(res, 500, { ok: false, error: "profile state read failed" });
      return;
    }

    try {
      await RaidProfileSnapshot.findOneAndUpdate(
        { discordId: userDoc.discordId },
        {
          $set: buildSnapshotUpdate({
            discordId: userDoc.discordId,
            clean: effectiveClean,
            promotePrimary,
            extraRangeSnapshots,
          }),
        },
        { upsert: true, setDefaultsOnInsert: true, new: true }
      );
      await User.updateOne(
        { discordId: userDoc.discordId, localProfileSyncTokenHash: userDoc.localProfileSyncTokenHash },
        { $set: { lastLocalProfileSyncAt: Date.now() } }
      );
    } catch (err) {
      console.error("[raid-profile-sync-endpoint] save failed:", err?.message || err);
      send(res, 500, { ok: false, error: "profile save failed" });
      return;
    }

    let newExpSec = null;
    try {
      newExpSec = await shrinkLocalSyncTokenAfterProfileUpload({
        User,
        discordId: userDoc.discordId,
        localSyncToken,
      });
    } catch (err) {
      console.warn("[raid-profile-sync-endpoint] local token shrink failed:", err?.message || err);
    }

    send(res, 200, {
      ok: true,
      discordId: userDoc.discordId,
      newExpSec,
      encounterWrite,
      totals: {
        ...effectiveClean.totals,
        encounterSummaries: encounterWrite.received,
      },
    });
  };
}

module.exports = {
  PROFILE_VERSION,
  MAX_BODY_BYTES,
  createProfileSessionEndpoint,
  createRaidProfileSyncEndpoint,
  sanitizeSnapshotPayload,
  upsertEncounterSummaries,
  shrinkLocalSyncTokenAfterProfileUpload,
};
