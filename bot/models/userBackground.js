"use strict";

const mongoose = require("mongoose");

const backgroundImageSchema = new mongoose.Schema(
  {
    imageData: { type: Buffer, required: true },
    mime: { type: String, default: "image/jpeg" },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    sizeBytes: { type: Number, default: 0 },
    originalWidth: { type: Number, default: 0 },
    originalHeight: { type: Number, default: 0 },
    originalFilename: { type: String, default: "" },
    originalMime: { type: String, default: "" },
    storageQuality: { type: Number, default: 85 },
  },
  { _id: false }
);

const backgroundAssignmentSchema = new mongoose.Schema(
  {
    accountName: { type: String, default: "" },
    accountKey: { type: String, default: "" },
    imageIndex: { type: Number, default: 0 },
  },
  { _id: false }
);

// Per-user background pool for the /raid-status embed image. Lives in a
// dedicated collection so multi-MB Binary payloads never bloat the User doc
// that every other command reads. A user has one document keyed by discordId,
// and that document can hold up to the command-level cap of resized JPEGs.
const userBackgroundSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, unique: true, index: true },
    mode: { type: String, enum: ["even", "random"], default: "even" },
    images: { type: [backgroundImageSchema], default: [] },
    assignments: { type: [backgroundAssignmentSchema], default: [] },
  },
  {
    timestamps: true,
    collection: "userbackgrounds",
  }
);

const UserBackground = mongoose.model("UserBackground", userBackgroundSchema);

module.exports = UserBackground;
