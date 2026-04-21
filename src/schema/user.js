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
    // lostark.bible identifiers cached the first time we fetch the
    // character's logs page — avoids re-scraping the SSR HTML on every
    // subsequent /raid-auto-manage sync. `sn` = characterSerial in
    // bible's API payload, `cid` = class id, `rid` = roster id. Null
    // until the first sync populates them.
    bibleSerial: { type: String, default: null },
    bibleCid: { type: Number, default: null },
    bibleRid: { type: Number, default: null },
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
    // Unix ms timestamp of the last successful lostark.bible fetch for this
    // account. Used by /raid-status lazy-refresh to skip API calls when the
    // cached data is still within the upstream Bible cadence (~2 hours).
    lastRefreshedAt: { type: Number, default: null },
    // Unix ms timestamp of the last refresh ATTEMPT (success or all-seeds-
    // failed). Used by /raid-status lazy-refresh to apply a shorter
    // failure-cooldown so repeated /raid-status calls don't re-queue the
    // full seed list against bible after every invocation when a roster is
    // unresolvable (wrong accountName + stale char names → every seed fails
    // or returns zero-overlap).
    lastRefreshAttemptAt: { type: Number, default: null },
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
    // Opt-in flag for /raid-auto-manage — when true, the bot is
    // allowed to pull lostark.bible clear logs for this user's
    // characters and reconcile raid progress automatically. Off by
    // default so no passive syncing happens without explicit consent.
    autoManageEnabled: { type: Boolean, default: false },
    // Unix ms timestamp of the last auto-manage sync ATTEMPT for this
    // user (success or total failure). Always stamped so status can
    // surface "last tried at" even when every char errored.
    lastAutoManageAttemptAt: { type: Number, default: null },
    // Unix ms timestamp of the last auto-manage sync where AT LEAST ONE
    // character fetched+reconciled without throwing. Kept separate from
    // the attempt stamp so a string of Cloudflare 403s doesn't lie about
    // data freshness.
    lastAutoManageSyncAt: { type: Number, default: null },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

const User = mongoose.model("User", userSchema);

/**
 * Execute an operation that reads a User document, mutates it, and saves,
 * retrying on VersionError (concurrent save) or E11000 (duplicate key on
 * first-time upsert race). The operation receives nothing and must perform
 * its own findOne + mutation + save each attempt because the document must
 * be re-fetched fresh on retry to avoid re-writing stale state.
 */
async function saveWithRetry(operation, maxAttempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isVersion = error?.name === "VersionError";
      const isDupKey = error?.code === 11000;
      if (!isVersion && !isDupKey) throw error;
      if (attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
    }
  }
  throw lastError;
}

module.exports = User;
module.exports.saveWithRetry = saveWithRetry;