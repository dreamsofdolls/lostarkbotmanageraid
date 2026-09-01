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
  normalizePreviewDeltas,
} = require("../..");
const {
  bucketizeCurrentWeekDeltas,
  projectSummary,
} = require("./preview-summary-endpoint");
const { getCurrentResetStartMs } = require("../../../raid/schedulers/weekly-reset");
const {
  createJsonSender,
} = require("../json");
const {
  readAuthenticatedJsonRequest,
  requireCurrentLocalSyncUser,
} = require("../request-gates");

const MAX_BODY_BYTES = 256 * 1024;

const STORED_DELIVERY = Object.freeze({
  delivered: false,
  channel: "stored",
  error: "discord delivery unavailable",
});

const PENDING_DELIVERY = Object.freeze({
  delivered: false,
  channel: "stored",
  pending: true,
});

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

function plainJobSnapshot(job) {
  return typeof job?.toObject === "function" ? job.toObject() : job;
}

function schedulePreviewDelivery({
  notifyPreviewReady,
  payload,
  scheduleTask,
  log,
}) {
  if (typeof notifyPreviewReady !== "function") return false;
  const run = async () => {
    try {
      const delivery = normalizeDeliveryResult(await notifyPreviewReady(payload));
      if (!delivery.delivered) {
        log.warn(
          "[preview-job-endpoint] Discord delivery unavailable; preview remains stored:",
          delivery.error
        );
      }
    } catch (err) {
      log.warn("[preview-job-endpoint] Discord delivery failed:", err?.message || err);
    }
  };
  try {
    scheduleTask(run);
    return true;
  } catch (err) {
    log.warn("[preview-job-endpoint] Discord delivery scheduling failed:", err?.message || err);
    return false;
  }
}

function createPreviewJobEndpoint({
  User,
  PreviewModel = null,
  notifyPreviewReady = null,
  scheduleTask = (task) => setImmediate(task),
  log = console,
}) {
  if (!User) throw new Error("[preview-job-endpoint] User model required");
  const send = createJsonSender({ methods: "POST, OPTIONS" });

  return async function handlePreviewJob(req, res) {
    const request = await readAuthenticatedJsonRequest({
      req,
      res,
      send,
      maxBodyBytes: MAX_BODY_BYTES,
    });
    if (!request) return;
    const { token, discordId, payload, scopeExplicit, body } = request;
    const scope = payload.scope;

    if (!Array.isArray(body?.deltas) || body.deltas.length === 0) {
      send(res, 400, { ok: false, error: "non-empty deltas array required" });
      return;
    }
    let normalizedDeltas;
    try {
      normalizedDeltas = normalizePreviewDeltas(body.deltas);
    } catch (err) {
      send(res, 400, { ok: false, error: err?.message || "preview job invalid" });
      return;
    }
    if (normalizedDeltas.length === 0) {
      send(res, 400, { ok: false, error: "no valid cleared deltas" });
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
      log.error("[preview-job-endpoint] state read failed:", err?.message || err);
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
        bucketizeCurrentWeekDeltas(normalizedDeltas, currentWeekStartMs),
        { scope, currentWeekStartMs }
      );
      job = await createPreviewJob({
        discordId,
        scope,
        deltas: normalizedDeltas,
        projection: buildStoredProjection(summary),
        token,
      }, PreviewModel ? { PreviewModel } : {});
    } catch (err) {
      send(res, 400, { ok: false, error: err?.message || "preview job invalid" });
      return;
    }

    const notificationPayload = {
      jobId: job.jobId,
      discordId,
      lang: payload.lang || userDoc?.language || "vi",
      // The endpoint has just loaded both snapshots. Reusing them lets the DM
      // path skip two immediate MongoDB reads without weakening apply-time
      // validation, which reloads the current user again when the button wins.
      job: plainJobSnapshot(job),
      userDoc,
    };
    const hasNotifier = typeof notifyPreviewReady === "function";
    send(res, 200, {
      ok: true,
      jobId: job.jobId,
      expiresAt: new Date(job.expiresAt).toISOString(),
      delivery: hasNotifier ? PENDING_DELIVERY : STORED_DELIVERY,
    });

    // A durable preview is the HTTP success boundary. Discord REST, console
    // rendering, and receipt persistence continue after res.end(), so slow or
    // blocked DMs cannot hold the Local Reader button in a loading state.
    if (hasNotifier) {
      schedulePreviewDelivery({
        notifyPreviewReady,
        payload: notificationPayload,
        scheduleTask,
        log,
      });
    }
  };
}

module.exports = {
  createPreviewJobEndpoint,
};
