const mongoose = require("mongoose");

const raidGateSchema = new mongoose.Schema(
  {
    difficulty: { type: String, default: "Normal" },
    completedDate: { type: Number, default: null },
  },
  { _id: false }
);

const assignedRaidSchema = new mongoose.Schema(
  {},
  { _id: false, strict: false }
);

const characterTaskSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    completions: { type: Number, default: 0 },
    completionDate: { type: Number, default: null },
  },
  { _id: false }
);

const characterSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    class: { type: String, required: true },
    itemLevel: { type: Number, required: true, min: 0 },
    combatScore: { type: String, default: "" },
    isGoldEarner: { type: Boolean, default: false },
    assignedRaids: {
      armoche: { type: assignedRaidSchema, default: () => ({}) },
      kazeros: { type: assignedRaidSchema, default: () => ({}) },
      serca: { type: assignedRaidSchema, default: () => ({}) },
    },
    tasks: { type: [characterTaskSchema], default: [] },
  },
  { _id: false }
);

const accountSchema = new mongoose.Schema(
  {
    accountName: { type: String, required: true },
    characters: { type: [characterSchema], default: [] },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, unique: true, index: true },
    weeklyResetKey: { type: String, default: "" },
    accounts: { type: [accountSchema], default: [] },
    tasks: {
      type: [
        {
          name: { type: String, required: true },
          type: { type: String, required: true },
          timesToComplete: { type: Number, default: 1 },
          id: { type: String, required: true },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

module.exports = mongoose.model("User", userSchema);