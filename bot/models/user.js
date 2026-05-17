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

// Account-level checklist items that are not tied to a specific character:
// event shops, Chaos Gate, Field Boss, and similar roster chores. Scheduled
// presets use `completedForKey` so a completion belongs to one hourly schedule
// slot instead of staying done forever.
const sharedTaskSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true },
    preset: {
      type: String,
      enum: ["custom", "event_shop", "chaos_gate", "field_boss"],
      default: "custom",
    },
    name: { type: String, required: true, maxlength: 60 },
    reset: {
      type: String,
      enum: ["daily", "weekly", "scheduled"],
      required: true,
    },
    completed: { type: Boolean, default: false },
    completedAt: { type: Number, default: null },
    completedForKey: { type: String, default: "" },
    lastResetAt: { type: Number, default: 0 },
    createdAt: { type: Number, default: () => Date.now() },
    expiresAt: { type: Number, default: null },
    archivedAt: { type: Number, default: null },
    timezone: { type: String, default: "America/Los_Angeles" },
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
    // Default true: chars added via /raid-add-roster opt INTO the gold rollup
    // by default. The 6-gold-earner-per-account-per-week LA cap is enforced
    // at the picker level in /raid-gold-earner, not here at the schema -
    // the schema just decides what a freshly-saved char should look like
    // when no explicit value was supplied. Existing docs saved before
    // this default flip retain whatever value they had stored (Mongoose
    // default only kicks in for missing fields at write time).
    isGoldEarner: { type: Boolean, default: true },
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
    sharedTasks: { type: [sharedTaskSchema], default: [] },
    // Discord id of the user who ran /raid-add-roster for this account when
    // acting on behalf of someone else (Manager onboarding flow). Null
    // when the owner self-added. Used by /raid-set to authorize the
    // helper Manager to keep maintaining raid progress on the registered
    // user's roster without re-checking the live Manager role - the act
    // of registering (which already gated through isManagerId) is the
    // authorization. Cleared only by /raid-remove-roster + /raid-add-roster cycle.
    registeredBy: { type: String, default: null },
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
    // Local-sync mode opt-in. MUTUALLY EXCLUSIVE with autoManageEnabled -
    // a user can have at most one active sync source at a time. Local-sync
    // pulls raid clears from the user's local LOA Logs encounters.db via a
    // browser-companion (File System Access API + sql.js); enable flow
    // lives in bot/services/local-sync/state.js so the mutex is enforced
    // at the data layer regardless of which UI surface flips the flag.
    localSyncEnabled: { type: Boolean, default: false },
    // Unix ms timestamp of the last successful local-sync POST received
    // from the web companion. Distinct from lastAutoManageSyncAt so the
    // /raid-auto-manage action:status can show both modes' freshness.
    lastLocalSyncAt: { type: Number, default: null },
    // Unix ms timestamp of the first time the user opted into local-sync
    // (set on the local-on action, cleared on local-off). Used by the
    // onboarding embed to show "Local sync linked X days ago".
    localSyncLinkedAt: { type: Number, default: null },
    // Most recently-minted local-sync URL token + its UTC seconds exp.
    // /raid-status renders a "Resume" button when this is still valid
    // (stored URL still opens companion with active session). Separate
    // "New link" button rotates this to a freshly-minted token. Cleared
    // on local-off so old links can't survive an opt-out.
    lastLocalSyncToken: { type: String, default: null },
    lastLocalSyncTokenExpAt: { type: Number, default: null },
    // Preferred display locale for Artist's responses. Drives every
    // user-facing string via bot/services/i18n.js. Default "vi" so
    // pre-existing users see no behavior change after the i18n rollout;
    // they have to opt in via /raid-language to switch (e.g. "jp").
    language: { type: String, default: "vi" },
    // NOTE: /raid-bg background image lives on the separate
    // UserBackground collection (bot/models/userBackground.js) so the
    // multi-MB Binary payload doesn't bloat User docs that are read by
    // every command. The User doc holds no bg fields by design.
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

// /raid-set autocomplete needs to look up every account whose registeredBy
// equals the executor's discordId, across the whole user collection (not
// just the executor's own doc). Multikey index keeps the cross-user scan
// O(matched-accounts) instead of full-collection. Partial filter trims the
// index to just the helper-Manager rows since the vast majority of accounts
// have registeredBy null (self-added).
userSchema.index(
  { "accounts.registeredBy": 1 },
  {
    name: "registered_by_scan",
    partialFilterExpression: { "accounts.registeredBy": { $type: "string" } },
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
