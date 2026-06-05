const mongoose = require("mongoose");

const raidProfileEncounterSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, index: true },
    encounterId: { type: String, required: true },
    accountName: { type: String, required: true },
    characterName: { type: String, required: true },
    characterNameKey: { type: String, required: true },
    class: { type: String, default: "" },
    itemLevel: { type: Number, default: 0 },
    classRole: { type: String, enum: ["dps", "support", "unknown"], default: "unknown" },
    role: { type: String, enum: ["dps", "support", "unknown"], default: "unknown" },
    fightStart: { type: Number, required: true, index: true },
    durationMs: { type: Number, default: 0 },
    boss: { type: String, default: "" },
    raidKey: { type: String, default: "" },
    modeKey: { type: String, default: "" },
    difficulty: { type: String, default: "" },
    rangeType: { type: String, enum: ["full", "weekly"], default: "full" },
    db: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    build: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    metrics: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    topSkills: { type: [mongoose.Schema.Types.Mixed], default: [] },
    receivedAt: { type: Number, default: () => Date.now() },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

raidProfileEncounterSchema.index(
  { discordId: 1, encounterId: 1, characterNameKey: 1 },
  { unique: true, name: "raid_profile_encounter_unique" }
);
raidProfileEncounterSchema.index(
  { discordId: 1, characterNameKey: 1, fightStart: -1 },
  { name: "raid_profile_encounter_character_timeline" }
);
raidProfileEncounterSchema.index(
  { discordId: 1, raidKey: 1, modeKey: 1, fightStart: -1 },
  { name: "raid_profile_encounter_raid_timeline" }
);

module.exports = mongoose.model(
  "RaidProfileEncounter",
  raidProfileEncounterSchema,
  "raid_profile_encounters"
);
