/**
 * models/RaidEvent.js
 * One document per /raid-schedule event (collection raid_events). Holds
 * the raid target, slot config, start time, optional room+password, and
 * the embedded signups. Forward-compat enums kept deliberately open:
 * `signupPolicy` and signup `status` reserve values (approval/whitelist,
 * pending/rejected) that v1 never sets but v2 can graft onto without a
 * migration. Invariant: roomPassword is never logged or rendered publicly.
 */

"use strict";

const mongoose = require("mongoose");

const signupSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true },
    accountName: { type: String, required: true },
    characterName: { type: String, required: true },
    characterClass: { type: String, default: "" },
    characterItemLevel: { type: Number, default: 0 },
    role: { type: String, enum: ["support", "dps"], required: true },
    // v1 sets only confirmed/late/tentative/absent/waitlisted; pending +
    // rejected are reserved for the deferred approval mode.
    status: {
      type: String,
      enum: ["confirmed", "late", "tentative", "absent", "waitlisted", "pending", "rejected"],
      default: "confirmed",
    },
    slotIndex: { type: Number, default: null },
    waitlistPos: { type: Number, default: null },
    alreadyClearedThisWeek: { type: Boolean, default: false },
    joinedAt: { type: Number, default: () => Date.now() },
  },
  { _id: false }
);

const raidEventSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, default: null, index: true },
    creatorId: { type: String, required: true, index: true },
    raidKey: { type: String, required: true },
    modeKey: { type: String, required: true },
    // Snapshot at creation so later catalog edits never retroactively re-gate.
    minItemLevel: { type: Number, required: true },
    partySize: { type: Number, required: true },
    supSlots: { type: Number, required: true },
    dpsSlots: { type: Number, required: true },
    title: { type: String, default: "" },
    // Absolute UTC; input parsed in the lead's language tz (/raid-language).
    startAt: { type: Date, required: true },
    autoLockAtStart: { type: Boolean, default: true },
    roomName: { type: String, default: null },
    roomPassword: { type: String, default: null },
    signupPolicy: { type: String, enum: ["open", "approval", "whitelist"], default: "open" },
    status: {
      type: String,
      enum: ["open", "locked", "cleared", "cancelled"],
      default: "open",
    },
    signups: { type: [signupSchema], default: [] },
    clearedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true, optimisticConcurrency: true }
);

// Find active events quickly (future list / auto-lock scan / cleanup).
raidEventSchema.index({ status: 1 });

module.exports = mongoose.model("RaidEvent", raidEventSchema, "raid_events");
