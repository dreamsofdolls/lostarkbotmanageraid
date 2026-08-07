"use strict";

const crypto = require("node:crypto");
const LocalSyncPreview = require("../../../models/localSyncPreview");
const { normalizeCompanionScope } = require("./scope");

const PREVIEW_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PREVIEW_DELTAS = 512;

function clipString(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizePreviewDelta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const boss = clipString(raw.boss, 256);
  const difficulty = clipString(raw.difficulty, 64);
  const charName = clipString(raw.charName, 128);
  const lastClearMs = Number(raw.lastClearMs);
  if (!boss || !difficulty || !charName || !Number.isFinite(lastClearMs) || lastClearMs <= 0) {
    return null;
  }
  return {
    boss,
    difficulty,
    cleared: raw.cleared === true || raw.cleared === 1,
    charName,
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

function fingerprintToken(token) {
  if (!token) return "";
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function resolveJobState(job, nowMs = Date.now()) {
  if (!job) return "missing";
  if (Number(new Date(job.expiresAt)) <= nowMs && job.status === "pending") return "expired";
  return job.status || "pending";
}

async function createPreviewJob({
  discordId,
  scope,
  deltas,
  projection = null,
  token = "",
  nowMs = Date.now(),
}, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  const normalizedScope = normalizeCompanionScope(scope, { legacyDefault: false });
  if (!discordId) throw new Error("discordId required");
  if (!normalizedScope) throw new Error("invalid companion scope");
  const normalizedDeltas = normalizePreviewDeltas(deltas);
  if (normalizedDeltas.length === 0) throw new Error("no valid deltas");

  await PreviewModel.updateMany(
    { discordId, status: "pending" },
    { $set: { status: "superseded", failureReason: "newer_preview" } }
  );

  return PreviewModel.create({
    jobId: crypto.randomUUID(),
    discordId,
    scope: normalizedScope,
    status: "pending",
    deltas: normalizedDeltas,
    projection,
    tokenFingerprint: fingerprintToken(token),
    expiresAt: new Date(nowMs + PREVIEW_JOB_TTL_MS),
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
  return PreviewModel.findOneAndUpdate(
    {
      jobId,
      discordId,
      status: "pending",
      expiresAt: { $gt: new Date() },
    },
    { $set: { status: "applying", failureReason: "" } },
    { new: true }
  );
}

async function releasePreviewJob(jobId, discordId, reason, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  return PreviewModel.findOneAndUpdate(
    { jobId, discordId, status: "applying" },
    { $set: { status: "pending", failureReason: String(reason || "") } },
    { new: true }
  );
}

async function finishPreviewJob(jobId, discordId, result, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  return PreviewModel.findOneAndUpdate(
    { jobId, discordId, status: "applying" },
    {
      $set: {
        status: "applied",
        result: result || null,
        failureReason: "",
        appliedAt: new Date(),
      },
    },
    { new: true }
  );
}

async function failPreviewJob(jobId, discordId, reason, result = null, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  return PreviewModel.findOneAndUpdate(
    { jobId, discordId, status: "applying" },
    {
      $set: {
        status: "failed",
        failureReason: String(reason || "apply_failed"),
        result,
      },
    },
    { new: true }
  );
}

async function cancelPreviewJob(jobId, discordId, deps = {}) {
  const PreviewModel = deps.PreviewModel || LocalSyncPreview;
  return PreviewModel.findOneAndUpdate(
    { jobId, discordId, status: "pending" },
    { $set: { status: "cancelled", cancelledAt: new Date() } },
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
  PREVIEW_JOB_TTL_MS,
  MAX_PREVIEW_DELTAS,
  normalizePreviewDelta,
  normalizePreviewDeltas,
  fingerprintToken,
  resolveJobState,
  createPreviewJob,
  getPreviewJob,
  getPreviewJobForUser,
  getLatestPreviewJob,
  claimPreviewJob,
  releasePreviewJob,
  finishPreviewJob,
  failPreviewJob,
  cancelPreviewJob,
  recordPreviewDelivery,
};
