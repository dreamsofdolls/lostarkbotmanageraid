/**
 * POST /api/local-sync/apply
 *
 * Applies one of the caller's stored preview jobs from the Local Reader. The
 * page calls it right after /preview-job. A retryable write error keeps the
 * job pending, so the page retries the same jobId and the gates written by
 * the first attempt still reach party propagation.
 */

"use strict";

const { getPreviewJobForUser } = require("../../core/preview-jobs");
const { createJsonSender } = require("../json");
const {
  readAuthenticatedJsonRequest,
  requireCurrentLocalSyncUser,
} = require("../request-gates");
const {
  publishLocalSyncApplied,
} = require("../../core/apply-events");

const APPLY_MAX_BODY_BYTES = 1024;

function ownEntries(entries) {
  return (entries || []).filter((entry) => !entry?.propagated);
}

// Party entries carry other owners' IDs, so the page only receives counts of
// the caller's own writes.
function buildApplyResponse(outcome) {
  const result = outcome.result || outcome.job?.result || null;
  const written = ownEntries(result?.applied);
  return {
    ok: outcome.state === "applied",
    state: outcome.state,
    retryable: outcome.retryable === true,
    written: {
      raids: written.length,
      chars: new Set(written.map((entry) => String(entry.charName || "").toLowerCase())).size,
    },
    rejected: ownEntries(result?.rejected)
      .filter((entry) => entry?.reason !== "write_error").length,
  };
}

/**
 * Build the `POST /api/local-sync/apply` handler.
 * @param {object} deps
 * @param {object} deps.User - User model
 * @param {(jobId: string, discordId: string) => Promise<object>} deps.applyPreviewJob -
 *   applyPreviewJob with the raid writers already bound
 * @param {object|null} [deps.PreviewModel] - preview job model override
 * @param {object} [deps.log]
 * @param {(event: object) => unknown} [deps.notifyLocalSyncApplied]
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createApplyEndpoint({
  User,
  applyPreviewJob,
  PreviewModel = null,
  log = console,
  notifyLocalSyncApplied = publishLocalSyncApplied,
}) {
  if (!User) throw new Error("[apply-endpoint] User model required");
  if (typeof applyPreviewJob !== "function") {
    throw new Error("[apply-endpoint] applyPreviewJob required");
  }
  const send = createJsonSender({ methods: "POST, OPTIONS" });
  const jobDeps = PreviewModel ? { PreviewModel } : {};

  return async function handleApply(req, res) {
    const request = await readAuthenticatedJsonRequest({
      req,
      res,
      send,
      maxBodyBytes: APPLY_MAX_BODY_BYTES,
    });
    if (!request) return;
    const { token, discordId, payload, scopeExplicit, body } = request;
    const jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";
    if (!jobId) {
      send(res, 400, { ok: false, error: "jobId required" });
      return;
    }

    let userDoc;
    let job;
    try {
      [userDoc, job] = await Promise.all([
        User.findOne({ discordId })
          .select("autoManageEnabled localSyncEnabled lastLocalSyncToken lastLocalSyncTokenExpAt")
          .lean(),
        getPreviewJobForUser(jobId, discordId, jobDeps),
      ]);
    } catch (err) {
      log.error("[apply-endpoint] state read failed:", err?.message || err);
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
    // A Solo link must not apply a Full job the same owner created elsewhere.
    if (!job || job.scope !== payload.scope) {
      send(res, 404, { ok: false, state: "missing", error: "preview job not found" });
      return;
    }

    let outcome;
    try {
      outcome = await applyPreviewJob(jobId, discordId);
    } catch (err) {
      log.error("[apply-endpoint] apply failed:", err?.message || err);
      send(res, 500, { ok: false, error: "apply failed" });
      return;
    }
    if (outcome?.state === "applied") {
      try {
        const notification = notifyLocalSyncApplied({ discordId, jobId });
        if (notification && typeof notification.then === "function") {
          Promise.resolve(notification).catch((err) => {
            (log.warn || log.error).call(
              log,
              "[apply-endpoint] applied notification failed:",
              err?.message || err
            );
          });
        }
      } catch (err) {
        (log.warn || log.error).call(
          log,
          "[apply-endpoint] applied notification failed:",
          err?.message || err
        );
      }
    }
    send(res, 200, buildApplyResponse(outcome));
  };
}

module.exports = {
  createApplyEndpoint,
};
