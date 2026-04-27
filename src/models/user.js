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

// User-defined "side tasks" attached to a character. Distinct from `tasks`
// above which tracks raid-clear completions ported from LoaLogs. Side tasks
// are arbitrary daily/weekly chores the player wants to track (Una dailies,
// Chaos runs, Guardian, GvG, anything). Auto-resets on the existing
// scheduler tick using `lastResetAt` vs the cycle boundary so the player
// doesn't have to clear flags manually. Field intentionally separate from
// any /raid-check select projection - this data must never leak into
// Manager-side views.
const sideTaskSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 60 },
    reset: { type: String, enum: ["daily", "weekly"], required: true },
    completed: { type: Boolean, default: false },
    lastResetAt: { type: Number, default: 0 },
    createdAt: { type: Number, default: () => Date.now() },
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
    // character's logs page - avoids re-scraping the SSR HTML on every
    // subsequent /raid-auto-manage sync. `sn` = characterSerial in
    // bible's API payload, `cid` = class id, `rid` = roster id. Null
    // until the first sync populates them.
    bibleSerial: { type: String, default: null },
    bibleCid: { type: Number, default: null },
    bibleRid: { type: Number, default: null },
    // Set true when the most recent auto-manage sync for this character
    // returned "Logs not enabled" from lostark.bible (public log OFF in
    // the player's bible profile), cleared to false when a subsequent
    // sync fetches logs successfully. Used by the /raid-check Edit flow
    // to carve out a per-char exception: normally the leader Edit button
    // skips chars that belong to opted-in (auto-sync) users because any
    // manual edit would be overwritten on the next bible sync, but a
    // char with public log OFF is never going to be bible-syncable so
    // the leader is the only one who can move its progress.
    publicLogDisabled: { type: Boolean, default: false },
    assignedRaids: {
      armoche: { type: assignedRaidSchema, default: () => ({}) },
      kazeros: { type: assignedRaidSchema, default: () => ({}) },
      serca: { type: assignedRaidSchema, default: () => ({}) },
    },
    tasks: { type: [characterTaskSchema], default: [] },
    // Per-character side tasks (daily/weekly chores). Cap is enforced at
    // the command layer (/raid-task add) because Mongoose subdoc validators
    // run against the whole array on every save and would reject legitimate
    // toggle-complete flows on a character that previously had >cap entries.
    sideTasks: { type: [sideTaskSchema], default: [] },
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
    // Cached Discord identity for operators/admins browsing MongoDB. The
    // authoritative key remains discordId; these fields are best-effort
    // display labels refreshed when the user runs a slash command.
    discordUsername: { type: String, default: "" },
    discordGlobalName: { type: String, default: "" },
    discordDisplayName: { type: String, default: "" },
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
    // Opt-in flag for /raid-auto-manage - when true, the bot is
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
    // Unix ms timestamp of the last channel-announcement nudge Artist
    // posted for this user when every char returned "Logs not enabled".
    // Dedup at 7 days so stuck users aren't spam-tagged each 30-min tick.
    lastPrivateLogNudgeAt: { type: Number, default: null },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

// Weekly reset wakes every 30 minutes and needs to find users whose cursor
// lags the current target week. The query still uses `$ne`, but an index on
// the cursor keeps that scheduler from hard-full-scanning forever as the user
// collection grows.
userSchema.index({ weeklyResetKey: 1 });

// /raid-check scans only need users with at least one character in the
// selected raid's broader iLvl scope. Multikey index lets Mongo prune users
// below the raid floor before the command does any render/pre-refresh work.
userSchema.index(
  { "accounts.characters.itemLevel": 1 },
  { name: "raid_check_item_level_scan" }
);
userSchema.index(
  { "accounts.lastRefreshedAt": 1 },
  { name: "raid_check_refresh_scan" }
);

// Phase 3 daily auto-manage tick filters to opted-in users, narrows by stale
// `lastAutoManageSyncAt`, then sorts by `lastAutoManageAttemptAt` for fair
// rotation. Partial index keeps the structure compact because only opted-in
// users participate in that scheduler path.
userSchema.index(
  {
    autoManageEnabled: 1,
    lastAutoManageSyncAt: 1,
    lastAutoManageAttemptAt: 1,
  },
  {
    name: "auto_manage_daily_scan",
    partialFilterExpression: { autoManageEnabled: true },
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
