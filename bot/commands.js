const {
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const GuildConfig = require("./models/guildConfig");
const { randomUUID } = require("node:crypto");
const User = require("./models/user");
const { saveWithRetry } = require("./models/user");
const {
  ensureFreshWeek,
  getTargetResetKey,
  getWeeklyResetSchedulerStartedAtMs,
  WEEKLY_RESET_TICK_MS,
} = require("./services/weekly-reset");
const {
  ConcurrencyLimiter,
  UI,
  normalizeName,
  foldName,
  parseCombatScore,
  toModeLabel,
  toModeKey,
  getCharacterName,
  getCharacterClass,
  truncateText,
  formatShortRelative,
  formatNextCooldownRemaining,
  waitWithBudget,
  buildDiscordIdentityFields,
  formatGold,
} = require("./utils/raid/shared");
const {
  announcementTypeKeys,
  announcementTypeEntry,
  announcementSubdocKeys,
  announcementOverridableTypeKeys,
} = require("./utils/raid/announcements");
const {
  createRaidStatusCommand,
  STATUS_PAGINATION_SESSION_MS,
  STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS,
} = require("./handlers/raid-status");
const {
  createRaidCheckCommand,
  RAID_CHECK_PAGINATION_SESSION_MS,
} = require("./handlers/raid-check");
const { createAddRosterCommand } = require("./handlers/add-roster");
const { createRaidGoldEarnerCommand } = require("./handlers/raid-gold-earner");
const { createEditRosterCommand } = require("./handlers/edit-roster");
const { createRaidCommandDefinitions } = require("./handlers/definitions");
const { createRaidAutoManageCommand } = require("./handlers/raid-auto-manage");
const { createRaidAnnounceCommand } = require("./handlers/raid-announce");
const { createRemoveRosterCommand } = require("./handlers/remove-roster");
const { createRaidChannelCommand } = require("./handlers/raid-channel");
const { createRaidHelpCommand } = require("./handlers/raid-help");
const { createRaidShareCommand } = require("./handlers/raid-share");
const { createRaidLanguageCommand } = require("./handlers/raid-language");
const { createRaidSetCommand } = require("./handlers/raid-set");
const {
  createRosterRefreshService,
  ROSTER_REFRESH_COOLDOWN_MS,
  ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
} = require("./services/roster-refresh");
const { createAutoManageSyncService } = require("./services/auto-manage-sync");
const { createRosterFetchService } = require("./services/roster-fetch");
const { createAutoManageCoreService } = require("./services/auto-manage-core");
const { createRaidChannelMonitorService } = require("./services/raid-channel-monitor");
const { createRaidSchedulerService } = require("./services/raid-schedulers");

const bibleLimiter = new ConcurrencyLimiter(2);
// Discord REST fan-out limiter: caps parallel `client.users.fetch` bursts in
// /raid-check (which resolves display names for every unique discordId with
// matching chars). discord.js serializes per-bucket internally, but a large
// raiding server could queue up dozens of fetches at once and trip the
// global 50-req/s ceiling - 5 in flight is a safe middle ground.
const discordUserLimiter = new ConcurrencyLimiter(5);
// /raid-check's initial render may pre-refresh multiple users before it scans.
// Keep that user-level fan-out bounded so one leader view doesn't stampede
// Mongo while still letting bible HTTP overlap through bibleLimiter.
const raidCheckRefreshLimiter = new ConcurrencyLimiter(3);
// Sync button can touch multiple opted-in users; bounded user-level fan-out
// keeps wall-clock reasonable without increasing bible HTTP concurrency beyond
// bibleLimiter's own max-2 global cap.
const raidCheckSyncLimiter = new ConcurrencyLimiter(3);
const rosterFetchService = createRosterFetchService({ bibleLimiter });
const { fetchRosterCharacters } = rosterFetchService;


/**
 * In-flight dedup loader for autocomplete paths. Rapid keystrokes for the
 * same discordId collapse into a single Mongo read - all concurrent handlers
 * await the same promise and the map entry clears once it settles.
 */
const autocompleteUserInFlight = new Map();
function loadUserForAutocomplete(discordId) {
  if (!autocompleteUserInFlight.has(discordId)) {
    const promise = User.findOne({ discordId })
      .lean()
      .finally(() => autocompleteUserInFlight.delete(discordId));
    autocompleteUserInFlight.set(discordId, promise);
  }
  return autocompleteUserInFlight.get(discordId);
}

/**
 * Cross-user lookup for /raid-set autocomplete: every user doc that has at
 * least one account with `registeredBy === discordId`. The executor (a
 * Manager who used /raid-add-roster target:) sees their helper-added rosters
 * alongside their own. Same in-flight dedup pattern as
 * `loadUserForAutocomplete` so per-keystroke autocomplete fan-out doesn't
 * stampede Mongo. Projects only the fields the picker label needs
 * (display-name cache + accounts) to keep result size compact.
 */
const accountsRegisteredByInFlight = new Map();
function loadAccountsRegisteredBy(discordId) {
  if (!accountsRegisteredByInFlight.has(discordId)) {
    const promise = User.find(
      { "accounts.registeredBy": discordId },
      {
        discordId: 1,
        discordUsername: 1,
        discordGlobalName: 1,
        discordDisplayName: 1,
        accounts: 1,
      }
    )
      .lean()
      .finally(() => accountsRegisteredByInFlight.delete(discordId));
    accountsRegisteredByInFlight.set(discordId, promise);
  }
  return accountsRegisteredByInFlight.get(discordId);
}
const {
  RAID_REQUIREMENTS,
  getRaidRequirementList,
  getRaidRequirementMap,
  getGatesForRaid,
  getRaidGateForBoss,
} = require("./models/Raid");
const {
  createCharacterId,
  buildFetchedRosterIndexes,
  pickUniqueFetchedRosterCandidate,
  findFetchedRosterMatchForCharacter,
  getRequirementFor,
  getBestEligibleModeKey,
  sanitizeTasks,
  getGateKeys,
  normalizeAssignedRaid,
  getCompletedGateKeys,
  buildAssignedRaidFromLegacy,
  ensureAssignedRaids,
  isAssignedRaidCompleted,
  buildCharacterRecord,
  ensureRaidEntries,
  getStatusRaidsForCharacter,
  formatRaidStatusLine,
  summarizeRaidProgress,
  summarizeAccountGold,
  summarizeGlobalGold,
  raidCheckGateIcon,
  RAID_REQUIREMENT_MAP,
} = require("./utils/raid/character");
const {
  RAID_CHECK_USER_QUERY_FIELDS,
  getRaidScanRange,
  buildRaidCheckUserQuery,
} = require("./utils/raid/raid-check-query");
const { createSchedulingHelpers } = require("./utils/raid/scheduling");

// Hard cap on characters saved per roster account. Sized to the
// /raid-add-roster + /raid-edit-roster picker capacity: Discord caps a message
// at 5 ActionRow components, the picker layout uses 1 row for
// Confirm/Cancel + 4 rows of 5 toggle buttons each = 20 max. Real
// Lost Ark rosters max ~18 chars per account in-game so 20 still has
// headroom.
const MAX_CHARACTERS_PER_ACCOUNT = 20;
// Raid leader gating: switched from Discord role-name match to an explicit
// env-configured user ID allowlist. Operator sets RAID_MANAGER_ID as
// comma-separated Discord user IDs (e.g. "123456789012345678,987654321098765432").
// Whitespace and empty entries are stripped. Empty/missing env = no raid
// leaders configured = /raid-check effectively disabled (boot warns).
//
// Why env-over-role: deterministic (no Discord role rename surprises),
// decoupled from server admin chain, multi-guild consistent, and rotation
// happens via redeploy rather than touching Discord role assignments.
//
// The same allowlist now also drives manager privileges (shorter auto-manage
// sync cooldown, on-roster visual tag). Shared helper lives in services/manager.js
// so raid-status / raid-check / auto-manage-core all read from one place.
const {
  MANAGER_IDS: RAID_MANAGER_ID,
  isManagerId,
  getAutoManageCooldownMs,
  getRosterRefreshCooldownMs,
  getPrimaryManagerId,
} = require("./services/manager");
if (RAID_MANAGER_ID.size === 0) {
  console.warn(
    "[raid-check] RAID_MANAGER_ID env not set or empty - /raid-check will reject every invocation. Set the env var to a comma-separated list of Discord user IDs to enable."
  );
}
// Round-32: /raid-check's `raid` option was removed entirely. The picker
// dropdown collapsed to one synthetic "all" entry (round-32a) and then
// the option was dropped (round-32b) because the inline raid-filter
// dropdown inside the all-mode embed already covers per-raid focus
// without a separate command-line argument. RAID_CHOICES was the
// /raid-check-specific choice list; nothing else consumed it, so it's
// gone too. /raid-set still uses its own autocomplete-driven raid input
// path, unaffected by this change.
const RAID_GROUP_KEYS = Object.keys(RAID_REQUIREMENTS);


function isRaidLeader(interaction) {
  // Env-allowlist check against the invoker's Discord user ID. Set is
  // built once at module load (see RAID_MANAGER_ID) so this is O(1)
  // per call. interaction.user.id is always present on slash commands -
  // no need to defensive-check member or guild context.
  const userId = interaction.user?.id;
  if (!userId) return false;
  return RAID_MANAGER_ID.has(userId);
}

const commands = createRaidCommandDefinitions({
  announcementTypeKeys,
  announcementTypeEntry,
});


async function resolveDiscordDisplay(client, discordId) {
  // Cache-first: discord.js populates users cache during normal gateway
  // events so most IDs are resolvable without a REST round-trip. Only miss
  // paths go through the limiter - keeps /raid-check fast on warm caches.
  const cached = client.users.cache.get(discordId);
  if (cached) return cached.username || discordId;
  try {
    const user = await discordUserLimiter.run(() => client.users.fetch(discordId));
    return user?.username || discordId;
  } catch {
    return discordId;
  }
}


// Shared scan+classify pass for /raid-check. Returns the raw eligible list
// + per-user metadata so both the initial command AND the button handlers
// (Remind / Sync) can operate on a fresh Mongo snapshot every time - no
// stale state map, no cache staleness bug. Initial render can optionally
// pre-refresh source users first so it matches `/raid-status` freshness.
// Composite key separator (Unit Separator \x1f) for maps keyed by
// discordId + accountName. Shared between rosterBuckets, rosterStats,
// and rosterRefreshMap so lookups line up across the three structures.
const ROSTER_KEY_SEP = "\x1f";

function toPlainUserSnapshot(userDoc) {
  if (!userDoc) return null;
  return typeof userDoc.toObject === "function" ? userDoc.toObject() : userDoc;
}

// Shared "render-facing" refresh helper: lazy-refresh stale roster data,
// optionally piggyback auto-manage, then return a plain object snapshot for
// commands that only need to read/render the result.
async function loadFreshUserSnapshotForRaidViews(
  seedDoc,
  { allowAutoManage = true, logLabel = "[raid-status]" } = {}
) {
  if (!seedDoc) return null;
  const discordId = seedDoc.discordId;
  if (!discordId) return toPlainUserSnapshot(seedDoc);

  const hasRoster = Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
  const didFreshenSeedWeek = ensureFreshWeek(seedDoc);

  if (!hasRoster) {
    if (!didFreshenSeedWeek) return toPlainUserSnapshot(seedDoc);
    try {
      return await saveWithRetry(async () => {
        const doc = await User.findOne({ discordId });
        if (!doc) return null;
        const didFreshenWeek = ensureFreshWeek(doc);
        if (didFreshenWeek) await doc.save();
        return doc.toObject();
      });
    } catch (err) {
      console.error(`${logLabel} refresh failed for ${discordId}:`, err?.message || err);
      return await User.findOne({ discordId }).lean();
    }
  }

  let autoManageGuard = null;
  try {
    let autoManagePromise = Promise.resolve(null);
    let autoManageWeekResetStart = null;
    if (allowAutoManage && seedDoc.autoManageEnabled) {
      autoManageGuard = await acquireAutoManageSyncSlot(discordId);
      if (autoManageGuard.acquired) {
        autoManageWeekResetStart = weekResetStartMs();
        autoManagePromise = gatherAutoManageLogsForUserDoc(
          seedDoc,
          autoManageWeekResetStart
        ).catch((err) => {
          console.warn(
            `${logLabel} auto-manage piggyback gather failed:`,
            err?.message || err
          );
          return null;
        });
      }
    }

    const [refreshCollected, autoManageCollected] = await Promise.all([
      collectStaleAccountRefreshes(seedDoc),
      autoManagePromise,
    ]);
    const autoManageBibleHit = autoManageGuard?.acquired === true;
    const needsFreshWrite =
      didFreshenSeedWeek || refreshCollected.length > 0 || autoManageBibleHit;

    if (!needsFreshWrite) return toPlainUserSnapshot(seedDoc);

    return await saveWithRetry(async () => {
      const doc = await User.findOne({ discordId });
      if (!doc) return null;
      const didFreshenWeek = ensureFreshWeek(doc);
      const didRefresh = applyStaleAccountRefreshes(doc, refreshCollected);

      let didAutoManage = false;
      if (autoManageCollected && doc.autoManageEnabled) {
        const autoReport = applyAutoManageCollected(
          doc,
          autoManageWeekResetStart,
          autoManageCollected
        );
        const now = Date.now();
        doc.lastAutoManageAttemptAt = now;
        if (autoReport.perChar.some((c) => !c.error)) {
          doc.lastAutoManageSyncAt = now;
        }
        didAutoManage = true;
      } else if (autoManageBibleHit) {
        doc.lastAutoManageAttemptAt = Date.now();
        didAutoManage = true;
      }

      if (didFreshenWeek || didRefresh || didAutoManage) await doc.save();
      return doc.toObject();
    });
  } catch (err) {
    console.error(`${logLabel} refresh failed for ${discordId}:`, err?.message || err);
    if (autoManageGuard?.acquired) {
      await stampAutoManageAttempt(discordId);
    }
    return await User.findOne({ discordId }).lean();
  } finally {
    if (autoManageGuard?.acquired) releaseAutoManageSyncSlot(discordId);
  }
}


let handleAddRosterCommand;
let handleAddRosterButton;
let handleRaidGoldEarnerCommand;
let handleRaidGoldEarnerAutocomplete;
let handleRaidGoldEarnerButton;
let handleEditRosterCommand;
let handleEditRosterAutocomplete;
let handleEditRosterButton;
let buildRaidCheckSnapshotFromUsers;
let formatRaidCheckNotEligibleFieldValue;
let getRaidCheckRenderableChars;
let computeRaidCheckSnapshot;
let buildEditableCharsByUser;
let getEligibleRaidsForChar;
let getCharRaidGateStatus;
let applyLocalRaidEditToChar;
let buildRaidCheckEditDMEmbed;
let handleRaidCheckCommand;
let handleRaidCheckButton;
let handleStatusCommand;
let applyAutoManageCollectedForStatus;
let collectStaleAccountRefreshes;
let hasStaleAccountRefreshes;
let applyStaleAccountRefreshes;
let formatRosterRefreshCooldownRemaining;
let buildAccountFreshnessLine;
let buildAccountPageEmbed;
let buildStatusFooterText;

// Generic Prev/Next pagination row builder. Customize customId prefix per
// command so the same visual/behavioral pattern works without collision:
// /raid-status uses `status:prev` / `status:next`, /raid-check uses
// `raid-check-page:prev` / `raid-check-page:next`. Each command's collector
// matches its own prefix; bot.js's global router doesn't see either
// (status:* isn't routed, raid-check-page:* deliberately NOT prefixed
// "raid-check:" to avoid the existing handleRaidCheckButton dispatcher).
function buildPaginationRow(currentPage, totalPages, disabled, { prevId, nextId }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(prevId)
      .setLabel("\u25C0 Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || currentPage === 0),
    new ButtonBuilder()
      .setCustomId(nextId)
      .setLabel("Next \u25B6")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || currentPage === totalPages - 1),
  );
}

let handleRaidSetAutocomplete;
let handleRaidSetCommand;
let applyRaidSetForDiscordId;

let handleRaidHelpCommand;
let handleRaidShareCommand;
let handleRaidHelpSelect;
let handleRaidLanguageCommand;
let handleRaidLanguageSelect;

let handleRemoveRosterAutocomplete;
let handleRemoveRosterCommand;
let handleRaidChannelAutocomplete;
let handleRaidChannelCommand;

async function cacheDiscordIdentityForExistingUser(interaction) {
  const discordId = interaction?.user?.id;
  if (!discordId) return;

  const identity = buildDiscordIdentityFields(interaction);
  if (!Object.values(identity).some(Boolean)) return;

  try {
    await User.updateOne(
      {
        discordId,
        $or: Object.entries(identity).map(([field, value]) => ({
          [field]: { $ne: value },
        })),
      },
      { $set: identity }
    );
  } catch (err) {
    console.warn(
      `[user-cache] failed to cache Discord identity for ${discordId}:`,
      err?.message || err
    );
  }
}

async function handleRaidManagementCommand(interaction) {
  try {
    if (interaction.commandName === "raid-add-roster") {
      await handleAddRosterCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-edit-roster") {
      await handleEditRosterCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-check") {
      await handleRaidCheckCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-set") {
      await handleRaidSetCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-status") {
      await handleStatusCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-share") {
      await handleRaidShareCommand(interaction);
      return;
    }
    if (interaction.commandName === "raid-language") {
      await handleRaidLanguageCommand(interaction);
      return;
    }
    if (interaction.commandName === "raid-help") {
      await handleRaidHelpCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-remove-roster") {
      await handleRemoveRosterCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-gold-earner") {
      await handleRaidGoldEarnerCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-channel") {
      await handleRaidChannelCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-auto-manage") {
      await handleRaidAutoManageCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-announce") {
      await handleRaidAnnounceCommand(interaction);
      return;
    }

    if (interaction.commandName === "raid-task") {
      await handleRaidTaskCommand(interaction);
    }
  } finally {
    await cacheDiscordIdentityForExistingUser(interaction);
  }
}


let handleRaidAnnounceCommand;
let handleRaidAnnounceAutocomplete;
let handleRaidAutoManageCommand;
let handleRaidAutoManageAutocomplete;
let handleRaidTaskCommand;
let handleRaidTaskAutocomplete;
let handleRaidTaskButton;

let AUTO_MANAGE_SYNC_COOLDOWN_MS;
let getAutoManageCooldownMsFromService;
let acquireAutoManageSyncSlot;
let releaseAutoManageSyncSlot;
let formatAutoManageCooldownRemaining;
let autoManageEntryKey;
let gatherAutoManageLogsForUserDoc;
let applyAutoManageCollected;
let syncAutoManageForUserDoc;
let stampAutoManageAttempt;
let isPublicLogDisabledError;
let commitAutoManageOn;
let buildAutoManageHiddenCharsWarningEmbed;
let buildAutoManageSyncReportEmbed;
let weekResetStartMs;

let AUTO_CLEANUP_TICK_MS;
let AUTO_MANAGE_DAILY_TICK_MS;
let MAINTENANCE_TICK_MS;
let postChannelAnnouncement;
let getTargetCleanupSlotKey;
let buildCleanupNoticePreview;
let buildMaintenancePreview;
let startRaidChannelScheduler;
let startAutoManageDailyScheduler;
let startMaintenanceScheduler;
let startSideTaskResetScheduler;
let getAutoCleanupSchedulerStartedAtMs;
let getAutoManageSchedulerStartedAtMs;
let getMaintenanceSchedulerStartedAtMs;
let getSideTaskSchedulerStartedAtMs;

let loadMonitorChannelCache;
let getMonitorCacheHealth;
let getCachedMonitorChannelId;
let setCachedMonitorChannelId;
let isTextMonitorEnabled;
let getMissingBotChannelPermissions;
let getMissingAnnouncementChannelPermissions;
let parseRaidMessage;
let handleRaidChannelMessage;
let cleanupRaidChannelMessages;
let postRaidChannelWelcome;
let resolveRaidMonitorChannel;

// Wire scheduling helpers via factory so the timing math can read the
// scheduler's started-at timestamps and tick intervals through closure-
// captured getters. The lazy `let` bindings above start undefined here
// and only get assigned by the service factory calls below; the getters
// defer the lookup until the helper functions are actually invoked at
// interaction-handler time, by which point those bindings hold real
// values.
const {
  getAnnouncementsConfig,
  nextIntervalTickMs,
  nextAnnouncementEligibleBoundaryMs,
  nextAnnouncementSchedulerCheckMs,
  formatDiscordTimestampPair,
  buildAnnouncementWhenItFiresText,
} = createSchedulingHelpers({
  announcementSubdocKeys,
  resolveWeeklyResetStarted: () => getWeeklyResetSchedulerStartedAtMs(),
  resolveWeeklyResetTickMs: () => WEEKLY_RESET_TICK_MS,
  resolveAutoCleanupStarted: () => getAutoCleanupSchedulerStartedAtMs?.(),
  resolveAutoCleanupTickMs: () => AUTO_CLEANUP_TICK_MS,
  resolveAutoManageStarted: () => getAutoManageSchedulerStartedAtMs?.(),
  resolveAutoManageDailyTickMs: () => AUTO_MANAGE_DAILY_TICK_MS,
  resolveMaintenanceStarted: () => getMaintenanceSchedulerStartedAtMs?.(),
  resolveMaintenanceTickMs: () => MAINTENANCE_TICK_MS,
  resolveMaintenanceSlotConfig: () => getMaintenanceSlotConfigSnapshot?.(),
});

const autoManageCoreService = createAutoManageCoreService({
  EmbedBuilder,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  toModeLabel,
  getCharacterName,
  getCharacterClass,
  fetchRosterCharacters,
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  getRaidGateForBoss,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  normalizeAssignedRaid,
  ensureAssignedRaids,
  bibleLimiter,
});
({
  AUTO_MANAGE_SYNC_COOLDOWN_MS,
  getAutoManageCooldownMs: getAutoManageCooldownMsFromService,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  formatAutoManageCooldownRemaining,
  autoManageEntryKey,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  syncAutoManageForUserDoc,
  stampAutoManageAttempt,
  isPublicLogDisabledError,
  commitAutoManageOn,
  buildAutoManageHiddenCharsWarningEmbed,
  buildAutoManageSyncReportEmbed,
  weekResetStartMs,
} = autoManageCoreService);

const addRosterCommandHandlers = createAddRosterCommand({
  EmbedBuilder,
  // /raid-add-roster picker = per-char toggle buttons + Confirm/Cancel,
  // no StringSelectMenu (the dropdown was visually noisy when
  // default-selected and got replaced with toggle buttons).
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  MAX_CHARACTERS_PER_ACCOUNT,
  fetchRosterCharacters,
  parseCombatScore,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  buildCharacterRecord,
  createCharacterId,
  isManagerId,
  getPrimaryManagerId,
});
({
  handleAddRosterCommand,
  handleAddRosterButton,
} = addRosterCommandHandlers);

const raidGoldEarnerCommandHandlers = createRaidGoldEarnerCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  loadUserForAutocomplete,
});
({
  handleRaidGoldEarnerCommand,
  handleRaidGoldEarnerAutocomplete,
  handleRaidGoldEarnerButton,
} = raidGoldEarnerCommandHandlers);

const editRosterCommandHandlers = createEditRosterCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  MAX_CHARACTERS_PER_ACCOUNT,
  fetchRosterCharacters,
  parseCombatScore,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  buildCharacterRecord,
  createCharacterId,
  loadUserForAutocomplete,
  getPrimaryManagerId,
});
({
  handleEditRosterCommand,
  handleEditRosterAutocomplete,
  handleEditRosterButton,
} = editRosterCommandHandlers);

const rosterRefreshService = createRosterRefreshService({
  normalizeName,
  foldName,
  getCharacterName,
  formatNextCooldownRemaining,
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  fetchRosterCharacters,
});
({
  collectStaleAccountRefreshes,
  hasStaleAccountRefreshes,
  applyStaleAccountRefreshes,
  formatRosterRefreshCooldownRemaining,
} = rosterRefreshService);

function shouldLoadFreshUserSnapshotForRaidViews(
  seedDoc,
  { allowAutoManage = true } = {}
) {
  if (!seedDoc?.discordId) return false;
  if (seedDoc.weeklyResetKey !== getTargetResetKey()) return true;
  const hasRoster =
    Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
  if (!hasRoster) return false;
  if (
    typeof hasStaleAccountRefreshes === "function" &&
    hasStaleAccountRefreshes(seedDoc)
  ) {
    return true;
  }
  return Boolean(allowAutoManage && seedDoc.autoManageEnabled);
}

const autoManageSyncService = createAutoManageSyncService({
  User,
  saveWithRetry,
  ensureFreshWeek,
  applyAutoManageCollected,
});
({ applyAutoManageCollectedForStatus } = autoManageSyncService);

const raidStatusCommand = createRaidStatusCommand({
  EmbedBuilder,
  ComponentType,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  getCharacterName,
  truncateText,
  formatShortRelative,
  formatNextCooldownRemaining,
  waitWithBudget,
  summarizeRaidProgress,
  summarizeAccountGold,
  summarizeGlobalGold,
  formatGold,
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
  buildPaginationRow,
  collectStaleAccountRefreshes,
  applyStaleAccountRefreshes,
  formatRosterRefreshCooldownRemaining,
  ROSTER_REFRESH_COOLDOWN_MS,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  applyAutoManageCollectedForStatus,
  stampAutoManageAttempt,
  weekResetStartMs,
  AUTO_MANAGE_SYNC_COOLDOWN_MS,
  getAutoManageCooldownMs,
  getRosterRefreshCooldownMs,
  isManagerId,
});
({
  handleStatusCommand,
  buildAccountFreshnessLine,
  buildAccountPageEmbed,
  buildStatusFooterText,
} = raidStatusCommand);

const raidCheckCommandHandlers = createRaidCheckCommand({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  toModeLabel,
  getCharacterName,
  truncateText,
  getGatesForRaid,
  ensureAssignedRaids,
  getGateKeys,
  getRaidScanRange,
  buildRaidCheckUserQuery,
  buildAccountPageEmbed,
  buildStatusFooterText,
  summarizeRaidProgress,
  getStatusRaidsForCharacter,
  buildPaginationRow,
  resolveDiscordDisplay,
  loadFreshUserSnapshotForRaidViews,
  shouldLoadFreshUserSnapshotForRaidViews,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  autoManageEntryKey,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  stampAutoManageAttempt,
  weekResetStartMs,
  isRaidLeader,
  isManagerId,
  // Late-bind thunk wrapper: raid-set's factory composes AFTER
  // raid-check's below, so the `applyRaidSetForDiscordId` `let` binding
  // is still undefined at the moment this dep object is built. The
  // arrow captures the outer binding by reference and is only invoked
  // at interaction time when raid-set has long since composed and
  // filled in the value.
  applyRaidSetForDiscordId: (args) => applyRaidSetForDiscordId(args),
  RAID_REQUIREMENT_MAP,
  RAID_CHECK_USER_QUERY_FIELDS,
  ROSTER_KEY_SEP,
  raidCheckRefreshLimiter,
  raidCheckSyncLimiter,
  discordUserLimiter,
});
({
  buildRaidCheckSnapshotFromUsers,
  formatRaidCheckNotEligibleFieldValue,
  getRaidCheckRenderableChars,
  computeRaidCheckSnapshot,
  buildEditableCharsByUser,
  getEligibleRaidsForChar,
  getCharRaidGateStatus,
  applyLocalRaidEditToChar,
  buildRaidCheckEditDMEmbed,
  handleRaidCheckCommand,
  handleRaidCheckButton,
} = raidCheckCommandHandlers);

const raidSetCommandHandlers = createRaidSetCommand({
  EmbedBuilder,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  createCharacterId,
  loadUserForAutocomplete,
  loadAccountsRegisteredBy,
  getRaidRequirementList,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  ensureAssignedRaids,
  normalizeAssignedRaid,
  getGateKeys,
  toModeLabel,
});
({
  handleRaidSetAutocomplete,
  handleRaidSetCommand,
  applyRaidSetForDiscordId,
} = raidSetCommandHandlers);

const raidChannelMonitorService = createRaidChannelMonitorService({
  PermissionFlagsBits,
  EmbedBuilder,
  UI,
  GuildConfig,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  applyRaidSetForDiscordId,
  getAnnouncementsConfig,
  normalizeName,
});
({
  loadMonitorChannelCache,
  getMonitorCacheHealth,
  getCachedMonitorChannelId,
  setCachedMonitorChannelId,
  isTextMonitorEnabled,
  getMissingBotChannelPermissions,
  getMissingAnnouncementChannelPermissions,
  parseRaidMessage,
  handleRaidChannelMessage,
  cleanupRaidChannelMessages,
  postRaidChannelWelcome,
  resolveRaidMonitorChannel,
} = raidChannelMonitorService);

const raidSchedulerService = createRaidSchedulerService({
  GuildConfig,
  User,
  saveWithRetry,
  ensureFreshWeek,
  getAnnouncementsConfig,
  cleanupRaidChannelMessages,
  weekResetStartMs,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  isPublicLogDisabledError,
  stampAutoManageAttempt,
});
({
  AUTO_CLEANUP_TICK_MS,
  AUTO_MANAGE_DAILY_TICK_MS,
  MAINTENANCE_TICK_MS,
  postChannelAnnouncement,
  getTargetCleanupSlotKey,
  buildCleanupNoticePreview,
  buildMaintenancePreview,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
  startMaintenanceScheduler,
  startSideTaskResetScheduler,
  getAutoCleanupSchedulerStartedAtMs,
  getAutoManageSchedulerStartedAtMs,
  getMaintenanceSchedulerStartedAtMs,
  getSideTaskSchedulerStartedAtMs,
} = raidSchedulerService);

// Expose quiet-hours helpers for __test access. Tests exercise them via
// commands.__test so they stay behind the public boundary and aren't
// part of the runtime contract other callers can reach for.
const {
  getTargetVNDayKey,
  getCurrentVNHour,
  isInArtistQuietHours,
  hasReachedArtistWakeupBoundary,
  pickBedtimeNoticeContent,
  pickWakeupNoticeContent,
  ARTIST_QUIET_START_HOUR_VN,
  ARTIST_QUIET_END_HOUR_VN,
  getMaintenanceSlotForNow,
  pickMaintenanceVariant,
  buildMaintenanceConfigQuery,
  getMaintenanceSlotConfigSnapshot,
  MAINTENANCE_DAY_VN,
  MAINTENANCE_HOUR_VN,
  MAINTENANCE_MINUTE_VN,
  dailyResetStartMs,
  resetExpiredSideTasks,
} = raidSchedulerService;

const raidHelpCommandHandlers = createRaidHelpCommand({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  MessageFlags,
  UI,
});
({
  handleRaidHelpCommand,
  handleRaidHelpSelect,
} = raidHelpCommandHandlers);

const raidShareCommandHandlers = createRaidShareCommand({
  EmbedBuilder,
  MessageFlags,
  UI,
});
({ handleRaidShareCommand } = raidShareCommandHandlers);

const raidLanguageCommandHandlers = createRaidLanguageCommand({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  MessageFlags,
  UI,
});
({
  handleRaidLanguageCommand,
  handleRaidLanguageSelect,
} = raidLanguageCommandHandlers);

const removeRosterCommandHandlers = createRemoveRosterCommand({
  EmbedBuilder,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  createCharacterId,
  loadUserForAutocomplete,
});
({
  handleRemoveRosterAutocomplete,
  handleRemoveRosterCommand,
} = removeRosterCommandHandlers);

const raidAnnounceCommandHandlers = createRaidAnnounceCommand({
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  UI,
  User,
  GuildConfig,
  normalizeName,
  truncateText,
  announcementTypeEntry,
  announcementOverridableTypeKeys,
  getAnnouncementsConfig,
  buildCleanupNoticePreview,
  buildMaintenancePreview,
  buildAnnouncementWhenItFiresText,
  getMissingAnnouncementChannelPermissions,
});
({
  handleRaidAnnounceCommand,
  handleRaidAnnounceAutocomplete,
} = raidAnnounceCommandHandlers);

const raidAutoManageCommandHandlers = createRaidAutoManageCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  formatAutoManageCooldownRemaining,
  getAutoManageCooldownMs,
  weekResetStartMs,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  isPublicLogDisabledError,
  commitAutoManageOn,
  buildAutoManageSyncReportEmbed,
  buildAutoManageHiddenCharsWarningEmbed,
  stampAutoManageAttempt,
});
({
  handleRaidAutoManageCommand,
  handleRaidAutoManageAutocomplete,
} = raidAutoManageCommandHandlers);

const { createRaidTaskCommand } = require("./handlers/raid-task");
const raidTaskCommandHandlers = createRaidTaskCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  User,
  saveWithRetry,
  loadUserForAutocomplete,
  dailyResetStartMs,
  weekResetStartMs,
});
({
  handleRaidTaskCommand,
  handleRaidTaskAutocomplete,
  handleRaidTaskButton,
} = raidTaskCommandHandlers);

const raidChannelCommandHandlers = createRaidChannelCommand({
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  UI,
  User,
  GuildConfig,
  normalizeName,
  getCachedMonitorChannelId,
  setCachedMonitorChannelId,
  getMonitorCacheHealth,
  isTextMonitorEnabled,
  getMissingBotChannelPermissions,
  postRaidChannelWelcome,
  postChannelAnnouncement,
  getAnnouncementsConfig,
  resolveRaidMonitorChannel,
  cleanupRaidChannelMessages,
  getTargetCleanupSlotKey,
});
({
  handleRaidChannelCommand,
  handleRaidChannelAutocomplete,
} = raidChannelCommandHandlers);


module.exports = {
  commands,
  handleRaidManagementCommand,
  handleRaidHelpSelect,
  handleRaidLanguageSelect,
  handleRaidSetAutocomplete,
  handleRemoveRosterAutocomplete,
  handleRaidChannelAutocomplete,
  handleRaidAutoManageAutocomplete,
  handleRaidAnnounceAutocomplete,
  handleRaidTaskAutocomplete,
  handleRaidTaskButton,
  handleRaidChannelMessage,
  handleRaidCheckButton,
  handleAddRosterButton,
  handleEditRosterAutocomplete,
  handleEditRosterButton,
  handleRaidGoldEarnerAutocomplete,
  handleRaidGoldEarnerButton,
  loadMonitorChannelCache,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
  startMaintenanceScheduler,
  startSideTaskResetScheduler,
  parseRaidMessage,
  __test: {
    buildRaidCheckSnapshotFromUsers,
    formatRaidCheckNotEligibleFieldValue,
    getRaidCheckRenderableChars,
    STATUS_PAGINATION_SESSION_MS,
    RAID_CHECK_PAGINATION_SESSION_MS,
    nextIntervalTickMs,
    nextAnnouncementEligibleBoundaryMs,
    nextAnnouncementSchedulerCheckMs,
    buildAnnouncementWhenItFiresText,
    buildRaidCheckUserQuery,
    foldName,
    buildFetchedRosterIndexes,
    findFetchedRosterMatchForCharacter,
    applyStaleAccountRefreshes,
    formatNextCooldownRemaining,
    buildAccountFreshnessLine,
    formatRosterRefreshCooldownRemaining,
    ROSTER_REFRESH_COOLDOWN_MS,
    ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
    MANAGER_ROSTER_REFRESH_COOLDOWN_MS: require("./services/manager").MANAGER_ROSTER_REFRESH_COOLDOWN_MS,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    isManagerId,
    getAutoManageCooldownMs,
    getRosterRefreshCooldownMs,
    getTargetVNDayKey,
    getCurrentVNHour,
    isInArtistQuietHours,
    hasReachedArtistWakeupBoundary,
    pickBedtimeNoticeContent,
    pickWakeupNoticeContent,
    ARTIST_QUIET_START_HOUR_VN,
    ARTIST_QUIET_END_HOUR_VN,
    buildMaintenancePreview,
    MAINTENANCE_TICK_MS,
    getMaintenanceSlotForNow,
    pickMaintenanceVariant,
    buildMaintenanceConfigQuery,
    MAINTENANCE_DAY_VN,
    MAINTENANCE_HOUR_VN,
    MAINTENANCE_MINUTE_VN,
    dailyResetStartMs,
    resetExpiredSideTasks,
    buildEditableCharsByUser,
    getEligibleRaidsForChar,
    getCharRaidGateStatus,
    applyLocalRaidEditToChar,
    buildRaidCheckEditDMEmbed,
  },
};
