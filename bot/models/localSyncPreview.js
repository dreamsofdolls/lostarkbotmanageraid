"use strict";

const mongoose = require("mongoose");

const localSyncDeltaSchema = new mongoose.Schema(
  {
    boss: { type: String, required: true },
    difficulty: { type: String, required: true },
    cleared: { type: Boolean, default: true },
    charName: { type: String, required: true },
    sourceCharName: { type: String, default: "" },
    lastClearMs: { type: Number, required: true },
  },
  { _id: false }
);

const localSyncPreviewSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    discordId: { type: String, required: true, index: true },
    scope: { type: String, enum: ["full", "solo"], required: true },
    status: {
      type: String,
      enum: ["pending", "applying", "applied", "cancelled", "superseded", "failed"],
      default: "pending",
      index: true,
    },
    deltas: { type: [localSyncDeltaSchema], default: [] },
    partyDeltas: { type: [localSyncDeltaSchema], default: [] },
    partyAuthorized: { type: Boolean, default: false },
    projection: { type: mongoose.Schema.Types.Mixed, default: null },
    tokenFingerprint: { type: String, default: "" },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    failureReason: { type: String, default: "" },
    applyingAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    deliveryChannelId: { type: String, default: "" },
    deliveryMessageId: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    collection: "localsyncpreviews",
  }
);

localSyncPreviewSchema.index({ discordId: 1, createdAt: -1 });
localSyncPreviewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("LocalSyncPreview", localSyncPreviewSchema);
