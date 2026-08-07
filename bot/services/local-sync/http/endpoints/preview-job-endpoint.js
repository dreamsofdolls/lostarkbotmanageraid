/**
 * POST /api/local-sync/preview-job
 *
 * The browser remains the local-file reader, but it no longer applies
 * raid progress directly. It stores a short-lived preview job and asks the
 * Discord surface to deliver the confirmation UI. The apply path is owned by
 * a Discord button whose user identity is checked again at click time.
 */

"use strict";

const {
  createPreviewJob,
} = require("../..");
const {
  bucketizeCurrentWeekDeltas,
  projectSummary,
} = require("./preview-summary-endpoint");
const { getCurrentResetStartMs } = require("../../../raid/schedulers/weekly-reset");
const {
  createJsonSender,
  readJsonBody,
} = require("../json");
const {
  guardHttpMethod,
  readVerifiedLocalSyncToken,
  requireCurrentLocalSyncUser,
} = require("../request-gates");

const MAX_BODY_BYTES = 256 * 1024;

function normalizeDeliveryResult(result) {
  if (result?.delivered) {
    return { delivered: true, channel: result.channel || "dm" };
  }
  return {
    delivered: false,
    channel: "stored",
    error: String(result?.error || "discord delivery unavailable"),
  };
}

function buildStoredProjection(summary) {
  return {
    changes: summary?.changes || { chars: 0, raids: 0, gates: 0 },
    changeDetails: Array.isArray(summary?.changeDetails) ? summary.changeDetails : [],
    completion: summary?.completion || null,
    goldDelta: {
      total: Number(summary?.goldDelta?.total) || 0,
      boundTotal: Number(summary?.goldDelta?.boundTotal) || 0,
    },
  };
}

function createPreviewJobEndpoint({
  User,
  PreviewModel = null,
  notifyPreviewReady = null,
}) {
  if (!User) throw new Error("[preview-job-endpoint] User model required");
  const send = createJsonSender({ methods: "POST, OPTIONS" });

  return async function handlePreviewJob(req, res, parsedUrl) {
    if (!guardHttpMethod({ req, res, send, method: "POST" })) return;
    const auth = readVerifiedLocalSyncToken({ req, res, parsedUrl, send });
    if (!auth) return;
    const { token, discordId, payload, scopeExplicit } = auth;
    const scope = payload.scope;

    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (err) {
      send(res, err.status || 400, { ok: false, error: err.message || "bad body" });
      return;
    }
    if (!Array.isArray(body?.deltas) || body.deltas.length === 0) {
      send(res, 400, { ok: false, error: "non-empty deltas array required" });
      return;
    }

    let userDoc;
    try {
      userDoc = await User.findOne({ discordId })
        .select(
          "autoManageEnabled localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt language " +
          "accounts.accountName accounts.characters.name accounts.characters.class " +
          "accounts.characters.itemLevel accounts.characters.isGoldEarner accounts.characters.assignedRaids"
        )
        .lean();
    } catch (err) {
      console.error("[preview-job-endpoint] state read failed:", err?.message || err);
      send(res, 500, { ok: false, error: "state read failed" });
      return;
    }
    if (!requireCurrentLocalSyncUser({
      userDoc,
      token,
      payload,
      scopeExplicit,
      res,
      send,
    })) return;

    let job;
    try {
      const currentWeekStartMs = getCurrentResetStartMs();
      const summary = projectSummary(
        userDoc.accounts || [],
        bucketizeCurrentWeekDeltas(body.deltas, currentWeekStartMs),
        { scope, currentWeekStartMs }
      );
      job = await createPreviewJob({
        discordId,
        scope,
        deltas: body.deltas,
        projection: buildStoredProjection(summary),
        token,
      }, PreviewModel ? { PreviewModel } : {});
    } catch (err) {
      send(res, 400, { ok: false, error: err?.message || "preview job invalid" });
      return;
    }

    let delivery = { delivered: false, channel: "stored", error: "discord delivery unavailable" };
    if (typeof notifyPreviewReady === "function") {
      try {
        delivery = normalizeDeliveryResult(await notifyPreviewReady({
          jobId: job.jobId,
          discordId,
          lang: payload.lang || userDoc?.language || "vi",
        }));
      } catch (err) {
        console.warn("[preview-job-endpoint] Discord delivery failed:", err?.message || err);
        delivery = normalizeDeliveryResult({ error: err?.message || err });
      }
    }

    send(res, 200, {
      ok: true,
      jobId: job.jobId,
      expiresAt: new Date(job.expiresAt).toISOString(),
      delivery,
    });
  };
}

module.exports = {
  buildStoredProjection,
  createPreviewJobEndpoint,
  normalizeDeliveryResult,
};
