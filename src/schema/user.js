const mongoose = require("mongoose");

const characterSchema = new mongoose.Schema(
  {
    charName: { type: String, required: true },
    className: { type: String, required: true },
    itemLevel: { type: Number, required: true, min: 0 },
    combatScore: { type: String, default: "" },
    isGoldEarner: { type: Boolean, default: false },
    raids: {
      type: [
        {
          raidName: { type: String, required: true },
          isCompleted: { type: Boolean, default: false },
          isJail: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
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
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

module.exports = mongoose.model("User", userSchema);