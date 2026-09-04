"use strict";

const crypto = require("node:crypto");
const LocalSyncPreview = require("../../../models/localSyncPreview");
const { assertPartyTargetFanout } = require("./party-policy");
const { normalizeCompanionScope } = require("./scope");

const PREVIEW_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const PREVIEW_APPLY_LEASE_MS = 2 * 60 * 1000;
const MAX_PREVIEW_DELTAS = 512;
const previewCreateLocks = new Map();

function clipString(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizePreviewDelta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const boss = clipString(raw.boss, 256);
  const difficulty = clipString(raw.difficulty, 64);
  const charName = clipString(raw.charName, 128);
  const sourceCharName = clipString(raw.sourceCharName, 128);
  const lastClearMs = Number(raw.lastClearMs);
  if (!boss || !difficulty || !charName || !Number.isFinite(lastClearMs) || lastClearMs <= 0) {
    return null;
  }
  return {
    boss,
    difficulty,
    cleared: raw.cleared === true || raw.cleared === 1,
    charName,
    sourceCharName,
    lastClearMs: Math.trunc(lastClearMs),
  };
}

function normalizePreviewDeltas(deltas) {
  if (!Array.isArray(deltas)) throw new Error("deltas array required");
  if (deltas.length > MAX_PREVIEW_DELTAS) {
    throw new Error(`too many deltas (max ${MAX_PREVIEW_DELTAS})`);
  }
  return deltas.map(normalizePreviewDelta).filter((delta) => delta?.cleared);
}

function deltaEvidenceKey(delta, charName = delta?.charName) {
  return [
    clipString(charName, 128).toLowerCase(),
    clipString(delta?.boss, 256).toLowerCase(),
    clipString(delta?.difficulty, 64).toLowerCase(),
    Math.trunc(Number(delta?.lastClearMs) || 0),
  ].join("\u0000");
}

function filterPartyDeltasBySourceDeltas(sourceDeltas, partyDeltas) {
  const sourceKeys = new Set((sourceDeltas || []).map((delta) => deltaEvidenceKey(delta)));
  return (partyDeltas || []).filter((delta) => (
    delta.sourceCharName
    && delta.sourceCharName.toLowerCase() !== delta.charName.toLowerCase()
    && sourceKeys.has(deltaEvidenceKey(delta, delta.sourceCharName))
  ));
}

function fingerprintToken(token) {
  if (!token) return "";
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function applyingLeaseIsActive(job, nowMs = Date.now()) {
  const applyingAtMs = Number(new Date(job?.applyingAt));
  return Number.isFinite(applyingAtMs)
    && applyingAtMs > nowMs - PREVIEW_APPLY_LEASE_MS;
}

function resolveJobState(job, nowMs = Date.now()) {
  if (!job) return "missing";
  const status = job.status || "pending";
  const expired = Number(new Date(job.expiresAt)) <= nowMs;
  if (status === "pending") return expired ? "expired" : "pending";
  if (status === "applying" && !applyingLeaseIsActive(job, nowMs)) {
    return expired ? "expired" : "pending";
  }
  return status;
}

function reclaimableStatusFilter(nowMs) {
  const staleBefore = new Date(nowMs - PREVIEW_APPLY_LEASE_MS);
  return {
    $or: [
      { status: "pending" },
      { status: "applying", applyingAt: { $lte: staleBefore } },
      { status: "applying", applyingAt: null },
    ],
  };
}

function resolveNowMs(deps = {}) {
  const injected = typeof deps.nowMs === "function" ? deps.nowMs() : deps.nowMs;
  const parsed = Number(injected);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function runPreviewCreateExclusive(discordId, task) {
  const previous = previewCreateLocks.get(discordId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  previewCreateLocks.set(discordId, current);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (previewCreateLocks.get(discordId) === current) {
      previewCreateLocks.delete(discordId);
    }
  }
}

async function createPreviewJob({
  discordId,
  scope,
  deltas,
  partyDeltas = [],
  projection = null,
  token = "",
  nowMs = Date.now(),
}, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  const normalizedScope = normalizeCompanionScope(scope, { legacyDefault: false });
  if (!discordId) throw new Error("discordId required");
  if (!normalizedScope) throw new Error("invalid companion scope");
  const normalizedDeltas = normalizePreviewDeltas(deltas);
  const normalizedPartyDeltas = normalizedScope === "full"
    ? filterPartyDeltasBySourceDeltas(
        normalizedDeltas,
        normalizePreviewDeltas(partyDeltas)
      )
    : [];
  assertPartyTargetFanout(normalizedPartyDeltas);
  if (normalizedDeltas.length === 0) throw new Error("no valid deltas");

  return runPreviewCreateExclusive(discordId, async () => {
    await PreviewModel.updateMany(
      { discordId, ...reclaimableStatusFilter(nowMs) },
      {
        $set: {
          status: "superseded",
          failureReason: "newer_preview",
          applyingAt: null,
        },
      }
    );

    return PreviewModel.create({
      jobId: crypto.randomUUID(),
      discordId,
      scope: normalizedScope,
      status: "pending",
      deltas: normalizedDeltas,
      partyDeltas: normalizedPartyDeltas,
      partyAuthorized: false,
      projection,
      tokenFingerprint: fingerprintToken(token),
      expiresAt: new Date(nowMs + PREVIEW_JOB_TTL_MS),
    });
  });
}

function leanIfSupported(query) {
  return typeof query?.lean === "function" ? query.lean() : query;
}

async function getPreviewJob(jobId, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  return leanIfSupported(PreviewModel.findOne({ jobId }));
}

async function getPreviewJobForUser(jobId, discordId, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  return leanIfSupported(PreviewModel.findOne({ jobId, discordId }));
}

async function getLatestPreviewJob(discordId, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  let query = PreviewModel.findOne({ discordId });
  if (typeof query?.sort === "function") query = query.sort({ createdAt: -1 });
  return leanIfSupported(query);
}

async function claimPreviewJob(jobId, discordId, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  const nowMs = resolveNowMs(deps);
  const applyingAt = new Date(nowMs);
  return PreviewModel.findOneAndUpdate(
    {
      jobId,
      discordId,
      expiresAt: { $gt: applyingAt },
      ...reclaimableStatusFilter(nowMs),
    },
    {
      $set: {
        status: "applying",
        applyingAt,
        failureReason: "",
        result: null,
        // Keep Mongo's TTL index from deleting a job while it is being applied.
        expiresAt: new Date(nowMs + PREVIEW_JOB_TTL_MS),
      },
    },
    { new: true }
  );
}

function applyingOwnerFilter(jobId, discordId, deps = {}) {
  const filter = { jobId, discordId, status: "applying" };
  if (deps.leaseStartedAt != null) {
    const leaseMs = Number(new Date(deps.leaseStartedAt));
    if (Number.isFinite(leaseMs)) filter.applyingAt = new Date(leaseMs);
  }
  return filter;
}

async function authorizePreviewParty(jobId, discordId, partyDeltas, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  const normalizedPartyDeltas = normalizePreviewDeltas(partyDeltas);
  assertPartyTargetFanout(normalizedPartyDeltas);
  return PreviewModel.findOneAndUpdate(
    applyingOwnerFilter(jobId, discordId, deps),
    {
      $set: {
        partyDeltas: normalizedPartyDeltas,
        partyAuthorized: true,
      },
    },
    { new: true }
  );
}

async function releasePreviewJob(jobId, discordId, reason, deps = {}, options = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  const update = {
    status: "pending",
    failureReason: String(reason || ""),
    applyingAt: null,
  };
  if (options.clearProjection) update.projection = null;
  if (Object.prototype.hasOwnProperty.call(options, "result")) {
    update.result = options.result;
  }
  return PreviewModel.findOneAndUpdate(
    applyingOwnerFilter(jobId, discordId, deps),
    { $set: update },
    { new: true }
  );
}

async function finishPreviewJob(jobId, discordId, result, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  return PreviewModel.findOneAndUpdate(
    applyingOwnerFilter(jobId, discordId, deps),
    {
      $set: {
        status: "applied",
        result: result || null,
        failureReason: "",
        applyingAt: null,
        appliedAt: new Date(),
      },
    },
    { new: true }
  );
}

async function failPreviewJob(jobId, discordId, reason, result = null, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  return PreviewModel.findOneAndUpdate(
    applyingOwnerFilter(jobId, discordId, deps),
    {
      $set: {
        status: "failed",
        failureReason: String(reason || "apply_failed"),
        result,
        applyingAt: null,
      },
    },
    { new: true }
  );
}

async function cancelPreviewJob(jobId, discordId, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  const nowMs = resolveNowMs(deps);
  return PreviewModel.findOneAndUpdate(
    {
      jobId,
      discordId,
      expiresAt: { $gt: new Date(nowMs) },
      ...reclaimableStatusFilter(nowMs),
    },
    {
      $set: {
        status: "cancelled",
        failureReason: "",
        applyingAt: null,
        cancelledAt: new Date(nowMs),
      },
    },
    { new: true }
  );
}

async function recordPreviewDelivery(jobId, discordId, message, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  const deliveryChannelId = String(message?.channelId || message?.channel?.id || "");
  const deliveryMessageId = String(message?.id || "");
  if (!deliveryChannelId || !deliveryMessageId) return null;
  return PreviewModel.findOneAndUpdate(
    { jobId, discordId },
    { $set: { deliveryChannelId, deliveryMessageId } },
    { new: true }
  );
}

module.exports = {
  PREVIEW_APPLY_LEASE_MS,
  normalizePreviewDeltas,
  filterPartyDeltasBySourceDeltas,
  fingerprintToken,
  resolveJobState,
  createPreviewJob,
  getPreviewJob,
  getPreviewJobForUser,
  getLatestPreviewJob,
  claimPreviewJob,
  authorizePreviewParty,
  releasePreviewJob,
  finishPreviewJob,
  failPreviewJob,
  cancelPreviewJob,
  recordPreviewDelivery,
};
