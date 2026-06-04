const mongoose = require("mongoose");

const raidProfileCharacterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    class: { type: String, default: "" },
    itemLevel: { type: Number, default: 0 },
    role: { type: String, enum: ["dps", "support", "unknown"], default: "unknown" },
    stats: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    scores: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    build: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    topSkills: { type: [mongoose.Schema.Types.Mixed], default: [] },
    topBuffSources: { type: [mongoose.Schema.Types.Mixed], default: [] },
    topDebuffSources: { type: [mongoose.Schema.Types.Mixed], default: [] },
    topShieldGivenSources: { type: [mongoose.Schema.Types.Mixed], default: [] },
    topShieldReceivedSources: { type: [mongoose.Schema.Types.Mixed], default: [] },
    raids: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { _id: false }
);

const raidProfileAccountSchema = new mongoose.Schema(
  {
    accountName: { type: String, required: true },
    characters: { type: [raidProfileCharacterSchema], default: [] },
  },
  { _id: false }
);

const raidProfileSnapshotSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, unique: true, index: true },
    source: { type: String, enum: ["local"], default: "local" },
    version: { type: Number, default: 1 },
    generatedAt: { type: Number, default: null },
    receivedAt: { type: Number, default: () => Date.now() },
    criteria: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    db: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    totals: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    accounts: { type: [raidProfileAccountSchema], default: [] },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

raidProfileSnapshotSchema.index(
  { "accounts.characters.name": 1 },
  { name: "raid_profile_character_name_scan" }
);

module.exports = mongoose.model(
  "RaidProfileSnapshot",
  raidProfileSnapshotSchema,
  "raid_profile_snapshots"
);
