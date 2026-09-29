/**
 * POST /api/local-sync/preview-job
 *
 * Stores the browser's delta preview as a short-lived job. The Local Reader
 * applies it next through POST /api/local-sync/apply; a job left pending can
 * still be applied from the /raid-status Local Sync view.
 */

"use strict";

const {
  createPreviewJob,
  filterPartyDeltasBySourceDeltas,
  normalizePreviewDeltas,
} = require("../..");
const { assertPartyTargetFanout } = require("../../core/party-policy");
const {
  bucketizeCurrentWeekDeltas,
  projectSummary,
} = require("../../core/preview-projection");
const { getCurrentResetStartMs } = require("../../../raid/schedulers/weekly-reset");
const {
  createJsonSender,
} = require("../json");
const {
  requireCurrentLocalSyncUser,
} = require("../request-gates");
const { readAuthenticatedPreviewRequest } = require("./preview-request");

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

/**
 * Build the `POST /api/local-sync/preview-job` handler.
 * @param {object} deps
 * @param {object} deps.User - User model
 * @param {object|null} [deps.PreviewModel] - preview job model override
 * @param {object} [deps.log]
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createPreviewJobEndpoint({
  User,
  PreviewModel = null,
  log = console,
}) {
  if (!User) throw new Error("[preview-job-endpoint] User model required");
  const send = createJsonSender({ methods: "POST, OPTIONS" });

  return async function handlePreviewJob(req, res) {
    const request = await readAuthenticatedPreviewRequest({ req, res, send });
    if (!request) return;
    const { token, discordId, payload, scope, scopeExplicit, body } = request;

    if (!Array.isArray(body?.deltas) || body.deltas.length === 0) {
      send(res, 400, { ok: false, error: "non-empty deltas array required" });
      return;
    }
    let normalizedDeltas;
    let normalizedPartyDeltas;
    try {
      normalizedDeltas = normalizePreviewDeltas(body.deltas);
      normalizedPartyDeltas = scope === "full"
        ? normalizePreviewDeltas(body.partyDeltas || [])
        : [];
      // The fan-out bound createPreviewJob enforces, checked here so the
      // request's own faults stay 400s and every later failure is a 500.
      assertPartyTargetFanout(
        filterPartyDeltasBySourceDeltas(normalizedDeltas, normalizedPartyDeltas)
      );
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
          "autoManageEnabled localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt " +
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
        partyDeltas: normalizedPartyDeltas,
        projection: buildStoredProjection(summary),
        token,
      }, PreviewModel ? { PreviewModel } : {});
    } catch (err) {
      log.error("[preview-job-endpoint] preview job failed:", err?.message || err);
      send(res, 500, { ok: false, error: "preview job failed" });
      return;
    }

    send(res, 200, {
      ok: true,
      jobId: job.jobId,
      expiresAt: new Date(job.expiresAt).toISOString(),
    });
  };
}

module.exports = {
  createPreviewJobEndpoint,
};
