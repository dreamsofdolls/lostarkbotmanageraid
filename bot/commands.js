const {
  AttachmentBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const GuildConfig = require("./models/guildConfig");
const User = require("./models/user");
const { saveWithRetry } = require("./models/user");
const {
  ensureFreshWeek,
  getTargetResetKey,
  getWeeklyResetSchedulerStartedAtMs,
  WEEKLY_RESET_TICK_MS,
} = require("./services/raid/schedulers/weekly-reset");
const {
  ConcurrencyLimiter,
  UI,
  normalizeName,
  foldName,
  parseCombatScore,
  toModeLabel,
  getCharacterName,
  getCharacterClass,
  truncateText,
  formatShortRelative,
  formatNextCooldownRemaining,
  waitWithBudget,
  buildDiscordIdentityFields,
  formatGold,
} = require("./utils/raid/common/shared");
const {
  announcementTypeKeys,
  announcementTypeEntry,
  announcementSubdocKeys,
  announcementSubdocDefaultEnabled,
  announcementOverridableTypeKeys,
} = require("./utils/raid/schedule/announcements");
const {
  createRaidStatusCommand,
  STATUS_PAGINATION_SESSION_MS,
} = require("./handlers/raid-status");
const {
  createRaidCheckCommand,
  RAID_CHECK_PAGINATION_SESSION_MS,
} = require("./handlers/raid-check");
const { createAddRosterCommand } = require("./handlers/roster/add");
const { createRaidGoldEarnerCommand } = require("./handlers/roster/gold-earner");
const { createRaidAuctionCommand } = require("./handlers/raid/auction");
const { createRaidLogCommand } = require("./handlers/raid/log");
const { createRaidLogCapture } = require("./services/raid-log/capture");
const { createRaidLogCatalog } = require("./services/raid-log/catalog");
const { createRecentRaidLogs } = require("./services/raid-log/recent");
const { createRaidScheduleCommand } = require("./handlers/raid/schedule");
// Board embed builders reused by /raid-check's "📋 Đội đã xếp" dropdown.
const { buildScheduleEmbed, buildTurnPlanEmbed } = require("./handlers/raid/schedule/view/board");
const { createEditRosterCommand } = require("./handlers/roster/edit");
const { createRaidCommandDefinitions } = require("./handlers/commands/command-definitions");
const { createRaidAutoManageCommand } = require("./handlers/raid/auto-manage");
const { createRaidAnnounceCommand } = require("./handlers/raid/announce");
const { createRemoveRosterCommand } = require("./handlers/roster/remove");
const { createRaidChannelCommand } = require("./handlers/raid/channel");
const { createRaidHelpCommand } = require("./handlers/meta/help");
const { createRaidShareCommand } = require("./handlers/raid/share");
const { createRaidLanguageCommand } = require("./handlers/meta/language");
const { createRaidBgCommand } = require("./handlers/raid/bg");
const { createRaidSetCommand } = require("./handlers/raid/set");
const { createRaidTaskCommand } = require("./handlers/raid/task");
const { createStuckNudgeButtonHandler } = require("./handlers/local-sync/stuck-nudge-button");
const { createLocalSyncDiscordConsole } = require("./handlers/local-sync/discord-console");
const { applyPreviewJob } = require("./services/local-sync");
const {
  createRosterRefreshService,
  ROSTER_REFRESH_COOLDOWN_MS,
  ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
} = require("./services/roster/refresh");
const { createManualRosterRefreshRunner } = require("./services/roster/manual-refresh");
const { createAutoManageSyncService } = require("./services/auto-manage/runtime/sync");
const { createRosterFetchService } = require("./services/roster/fetch");
const { createAutoManageCoreService } = require("./services/auto-manage/runtime/core");
const {
  BibleRequestLimiter,
} = require("./services/auto-manage/bible/rate-limit");
const { createRaidViewSnapshotService } = require("./services/raid/view-snapshot");
const { createRaidChannelMonitorService } = require("./services/raid/channel-monitor/channel-monitor");
const { createRaidSchedulerService } = require("./services/raid/schedulers/schedulers");
const { createRaidScheduleAutoLockService } = require("./services/raid/schedule/lifecycle/auto-lock");
const { createDiscordIdentityCache } = require("./services/discord/user-identity-cache");
const { createInFlightLoader } = require("./utils/async/in-flight-loader");
const RaidEvent = require("./models/RaidEvent");

const bibleLimiter = new BibleRequestLimiter(2);
// Discord REST fan-out limiter: caps parallel `client.users.fetch` bursts in
// /raid-check (which resolves display names for every unique discordId with
// matching chars). discord.js serializes per-bucket internally, but a large
// raiding server could queue up dozens of fetches at once and trip the
// global 50-req/s ceiling - 5 in flight is a safe middle ground.
const discordUserLimiter = new ConcurrencyLimiter(5);
// /raid-check refreshes stale users after its first render. Keep that
// background fan-out bounded so one leader view doesn't stampede Mongo while
// still letting bible HTTP overlap through bibleLimiter.
const raidCheckRefreshLimiter = new ConcurrencyLimiter(3);
// Sync button can touch multiple opted-in users; bounded user-level fan-out
// keeps wall-clock reasonable without increasing bible HTTP concurrency beyond
// bibleLimiter's own max-2 global cap.
const raidCheckSyncLimiter = new ConcurrencyLimiter(3);
const rosterFetchService = createRosterFetchService({ bibleLimiter });
const { fetchRosterCharacters } = rosterFetchService;

// A one-second resolved-value window covers Discord's rapid per-keystroke
// autocomplete burst without turning this into long-lived application state.
// Keep it on autocomplete-only wrappers: command/write paths continue using
// the fresh in-flight loaders below and never observe a settled stale value.
const AUTOCOMPLETE_CACHE_OPTIONS = Object.freeze({
  ttlMs: 1_000,
  maxEntries: 250,
});
const loadUserForAutocomplete = createInFlightLoader((discordId) =>
  User.findOne({ discordId }).lean()
);
const loadCachedUserForAutocomplete = createInFlightLoader(
  loadUserForAutocomplete,
  AUTOCOMPLETE_CACHE_OPTIONS
);

/**
 * Cross-user lookup for /raid-set autocomplete: every user doc that has at
 * least one account with `registeredBy === discordId`. The executor (a
 * Manager who used /raid-add-roster target:) sees their helper-added rosters
 * alongside their own. Same in-flight dedup pattern as
 * `loadUserForAutocomplete` so per-keystroke autocomplete fan-out doesn't
 * stampede Mongo. Projects only the fields the picker label needs
 * (display-name cache + accounts) to keep result size compact.
 */
const loadAccountsRegisteredBy = createInFlightLoader(
  (discordId) =>
    User.find(
      { "accounts.registeredBy": discordId },
      {
        discordId: 1,
        discordUsername: 1,
        discordGlobalName: 1,
        discordDisplayName: 1,
        accounts: 1,
      }
    ).lean()
);
const loadCachedAccountsRegisteredBy = createInFlightLoader(
  loadAccountsRegisteredBy,
  AUTOCOMPLETE_CACHE_OPTIONS
);
const {
  getRaidRequirementList,
  getGatesForRaid,
  getRaidLabel,
  getRaidGateForBoss,
} = require("./domain/raid-catalog");
const {
  createCharacterId,
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  getGateKeys,
  normalizeAssignedRaid,
  ensureAssignedRaids,
  buildCharacterRecord,
  getStatusRaidsForCharacter,
  formatRaidStatusLine,
  summarizeRaidProgress,
  summarizeAccountGold,
  summarizeGlobalGold,
  RAID_REQUIREMENT_MAP,
} = require("./utils/raid/common/character");
const {
  RAID_CHECK_USER_QUERY_FIELDS,
} = require("./utils/raid/queries/raid-check");
const {
  createAnnouncementsConfigReader,
  createSchedulingHelpers,
} = require("./utils/raid/schedule/scheduling");

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
// sync cooldown, on-roster visual tag). Shared helper lives in services/access/manager.js
// so raid-status / raid-check / auto-manage-core all read from one place.
const {
  MANAGER_IDS: RAID_MANAGER_ID,
  isManagerId,
  getAutoManageCooldownMs,
  getRosterRefreshCooldownMs,
  getPrimaryManagerId,
} = require("./services/access/manager");
const { getAccessibleAccounts } = require("./services/access/access-control");
const loadAccessibleAccountsForAutocomplete = createInFlightLoader(
  (discordId) => getAccessibleAccounts(discordId, { includeOwn: false }),
  AUTOCOMPLETE_CACHE_OPTIONS
);
if (RAID_MANAGER_ID.size === 0) {
  console.warn(
    "[raid-check] RAID_MANAGER_ID env not set or empty - /raid-check will reject every invocation. Set the env var to a comma-separated list of Discord user IDs to enable."
  );
}
// /raid-check intentionally has no command-line raid choice: its inline
// filter owns per-raid focus. /raid-set continues to use its independent
// autocomplete-driven raid input.
function isRaidLeader(interaction) {
  // Env-allowlist check against the invoker's Discord user ID. Set is
  // built once at module load (see services/access/manager.js) so this is O(1)
  // per call. interaction.user.id is always present on slash commands -
  // no need to defensive-check member or guild context.
  const userId = interaction.user?.id;
  return isManagerId(userId);
}

const commands = createRaidCommandDefinitions({
  announcementTypeKeys,
  announcementTypeEntry,
});

// Composite key separator (Unit Separator \x1f) for maps keyed by
// discordId + accountName. Shared between rosterBuckets, rosterStats,
// and rosterRefreshMap so lookups line up across the three structures.
const ROSTER_KEY_SEP = "\x1f";

// Generic Prev/Next pagination row builder. Customize customId prefix per
// command so the same visual/behavioral pattern works without collision:
// /raid-status uses `status:prev` / `status:next`, /raid-check uses
// `raid-check-page:prev` / `raid-check-page:next`. Each command's collector
// matches its own prefix; bot.js's global router doesn't see either
// (status:* isn't routed, raid-check-page:* deliberately NOT prefixed
// "raid-check:" to avoid the existing handleRaidCheckButton dispatcher).
function buildPaginationRow(currentPage, totalPages, disabled, { prevId, nextId, lang }) {
  // Lang is optional - back-compat with callers that haven't been
  // migrated yet (default "vi" via t() fallback). When passed, button
  // labels render in the viewer's locale.
  const { t } = require("./services/i18n");
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(prevId)
      .setLabel(t("common.pagination.previous", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || currentPage === 0),
    new ButtonBuilder()
      .setCustomId(nextId)
      .setLabel(t("common.pagination.next", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || currentPage === totalPages - 1),
  );
}

const cacheDiscordIdentityForExistingUser = createDiscordIdentityCache({
  User,
  buildDiscordIdentityFields,
});

// Services and command handlers below are built in dependency order, so
// each one takes the functions it needs straight from an earlier factory.

const {
  AUTO_MANAGE_SYNC_COOLDOWN_MS,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  formatAutoManageCooldownRemaining,
  autoManageEntryKey,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  stampAutoManageAttempt,
  isPublicLogDisabledError,
  commitAutoManageOn,
  buildAutoManageHiddenCharsWarningEmbed,
  buildAutoManageSyncReportEmbed,
  weekResetStartMs,
} = createAutoManageCoreService({
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

const {
  handleAddRosterCommand,
  handleAddRosterButton,
} = createAddRosterCommand({
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

const {
  handleRaidGoldEarnerCommand,
  handleRaidGoldEarnerAutocomplete,
  handleRaidGoldEarnerButton,
} = createRaidGoldEarnerCommand({
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

const { handleRaidAuctionCommand } = createRaidAuctionCommand({
  EmbedBuilder,
  MessageFlags,
  UI,
  User,
});

const { handleRaidLogCommand, handleRaidLogComponent } = createRaidLogCommand({
  EmbedBuilder, AttachmentBuilder, MessageFlags, UI, User,
  captureRaidLog: createRaidLogCapture({ bibleLimiter, idleMs: 45_000 }),
  logCatalog: createRaidLogCatalog({ bibleLimiter }),
  recentLogs: createRecentRaidLogs({ bibleLimiter }),
});

const {
  handleEditRosterCommand,
  handleEditRosterAutocomplete,
  handleEditRosterButton,
} = createEditRosterCommand({
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
  loadUserForAutocomplete: loadCachedUserForAutocomplete,
  getPrimaryManagerId,
});

const {
  collectStaleAccountRefreshes,
  collectAccountRefresh,
  hasStaleAccountRefreshes,
  applyStaleAccountRefreshes,
  formatRosterRefreshCooldownRemaining,
} = createRosterRefreshService({
  normalizeName,
  foldName,
  getCharacterName,
  formatNextCooldownRemaining,
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  fetchRosterCharacters,
  getRosterRefreshCooldownMs,
});

const { runManualRosterRefresh } = createManualRosterRefreshRunner({
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  collectAccountRefresh,
  applyStaleAccountRefreshes,
});

const {
  commitAutoManageCollected,
  applyAutoManageCollectedForStatus,
} = createAutoManageSyncService({
  User,
  saveWithRetry,
  ensureFreshWeek,
  applyAutoManageCollected,
});

const {
  loadFreshUserSnapshotForRaidViews,
  shouldLoadFreshUserSnapshotForRaidViews,
} = createRaidViewSnapshotService({
  User,
  saveWithRetry,
  ensureFreshWeek,
  getTargetResetKey,
  collectStaleAccountRefreshes,
  hasStaleAccountRefreshes,
  applyStaleAccountRefreshes,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  stampAutoManageAttempt,
  weekResetStartMs,
});

// /raid-set comes before everything that writes raid progress through it:
// the /raid-status Local Sync view, the Local Sync console, /raid-schedule
// and the raid channel monitor.
const {
  handleRaidSetAutocomplete,
  handleRaidSetCommand,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId,
} = createRaidSetCommand({
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
  loadCachedUserForAutocomplete,
  loadCachedAccountsRegisteredBy,
  loadAccessibleAccountsForAutocomplete,
  getRaidRequirementList,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  ensureAssignedRaids,
  normalizeAssignedRaid,
  getGateKeys,
  toModeLabel,
});

const {
  handleStatusCommand,
  buildAccountFreshnessLine,
  buildAccountPageEmbed,
  buildStatusFooterText,
} = createRaidStatusCommand({
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
  runManualRosterRefresh,
  formatRosterRefreshCooldownRemaining,
  ROSTER_REFRESH_COOLDOWN_MS,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  commitAutoManageCollected,
  applyAutoManageCollectedForStatus,
  stampAutoManageAttempt,
  weekResetStartMs,
  AUTO_MANAGE_SYNC_COOLDOWN_MS,
  getAutoManageCooldownMs,
  getRosterRefreshCooldownMs,
  isManagerId,
  // Local Sync view (`status-local:` buttons).
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId,
});

const {
  handleRaidCheckCommand,
  handleRaidCheckButton,
} = createRaidCheckCommand({
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
  buildAccountPageEmbed,
  buildStatusFooterText,
  summarizeRaidProgress,
  getStatusRaidsForCharacter,
  buildPaginationRow,
  loadFreshUserSnapshotForRaidViews,
  shouldLoadFreshUserSnapshotForRaidViews,
  runManualRosterRefresh,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  autoManageEntryKey,
  gatherAutoManageLogsForUserDoc,
  commitAutoManageCollected,
  isPublicLogDisabledError,
  stampAutoManageAttempt,
  weekResetStartMs,
  isRaidLeader,
  isManagerId,
  RAID_REQUIREMENT_MAP,
  RAID_CHECK_USER_QUERY_FIELDS,
  ROSTER_KEY_SEP,
  raidCheckRefreshLimiter,
  raidCheckSyncLimiter,
  discordUserLimiter,
  buildAutoManageSyncReportEmbed,
  // raid-schedule bridge for the "📋 Đội đã xếp" dropdown (teams-view.js).
  RaidEvent,
  buildScheduleEmbed,
  buildTurnPlanEmbed,
});

const {
  handleLocalSyncButton,
  handleLocalSyncRosterSelect,
} = createLocalSyncDiscordConsole({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  truncateText,
  MessageFlags,
  UI,
  User,
  formatGold,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  openRaidStatusSession: handleStatusCommand,
});

/**
 * Apply a preview job for the Local Reader web page. The page applies from
 * the tab that holds the link, so the token keeps its full lifetime for the
 * next clear of the session.
 * @param {string} jobId
 * @param {string} discordId - job owner, from the verified link token
 * @returns {Promise<object>} the applyPreviewJob outcome
 */
function applyLocalSyncPreviewJob(jobId, discordId) {
  return applyPreviewJob(jobId, discordId, {
    UserModel: User,
    applyRaidSetForDiscordId,
    applyRaidSetBatchForDiscordId,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    shrinkSourceToken: false,
  });
}

const raidScheduleCommandHandlers = createRaidScheduleCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  UI,
  User,
  GuildConfig,
  RaidEvent,
  isManagerId,
  applyRaidSetBatchForDiscordId,
});
const {
  handleRaidScheduleCommand,
  handleRaidScheduleButton,
  handleRaidScheduleSelect,
} = raidScheduleCommandHandlers;

const { startRaidScheduleAutoLockScheduler } = createRaidScheduleAutoLockService({
  RaidEvent,
  GuildConfig,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  boardPayload: raidScheduleCommandHandlers.boardPayload,
});

// Normalizes a guild's announcement settings. The channel monitor, the
// schedulers and /raid-announce and /raid-channel all read it.
const getAnnouncementsConfig = createAnnouncementsConfigReader({
  announcementSubdocKeys,
  announcementSubdocDefaultEnabled,
});

const {
  loadMonitorChannelCache,
  getMonitorCacheHealth,
  getCachedMonitorChannelId,
  setCachedMonitorChannelId,
  isTextMonitorEnabled,
  getMissingBotChannelPermissions,
  getMissingAnnouncementChannelPermissions,
  parseRaidMessage,
  handleRaidChannelMessage,
  cleanupAndRefreshRaidChannel,
  postRaidChannelWelcome,
  resolveRaidMonitorChannel,
} = createRaidChannelMonitorService({
  PermissionFlagsBits,
  EmbedBuilder,
  UI,
  GuildConfig,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  getRaidLabel,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId,
  getAccessibleAccounts,
  getAnnouncementsConfig,
  normalizeName,
});

const {
  AUTO_CLEANUP_TICK_MS,
  AUTO_MANAGE_DAILY_TICK_MS,
  MAINTENANCE_TICK_MS,
  WORLD_EVENT_REMINDER_TICK_MS,
  postChannelAnnouncement,
  getTargetCleanupSlotKey,
  buildCleanupNoticePreview,
  cleanupCountBucket,
  buildMaintenancePreview,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
  startMaintenanceScheduler,
  startWorldEventReminderScheduler,
  startSideTaskResetScheduler,
  getAutoCleanupSchedulerStartedAtMs,
  getAutoManageSchedulerStartedAtMs,
  getMaintenanceSchedulerStartedAtMs,
  getWorldEventReminderSchedulerStartedAtMs,
  nextWorldEventReminderBoundaryMs,
  // Quiet-hours and maintenance helpers, exposed through commands.__test
  // so tests reach them without making them part of the runtime contract.
  getTargetVNDayKey,
  getCurrentVNHour,
  isInArtistQuietHours,
  hasReachedArtistWakeupBoundary,
  pickBedtimeNoticeContent,
  pickWakeupNoticeContent,
  getMaintenanceSlotForNow,
  pickMaintenanceVariant,
  buildMaintenanceConfigQuery,
  getMaintenanceSlotConfigSnapshot,
  MAINTENANCE_DAY_VN,
  MAINTENANCE_HOUR_VN,
  MAINTENANCE_MINUTE_VN,
  dailyResetStartMs,
} = createRaidSchedulerService({
  GuildConfig,
  User,
  saveWithRetry,
  ensureFreshWeek,
  getAnnouncementsConfig,
  cleanupAndRefreshRaidChannel,
  weekResetStartMs,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  collectAccountRefresh,
  applyStaleAccountRefreshes,
});

// Announcement timing reads each scheduler's start time and tick length.
// Start times are getters: a scheduler only has one once it has started.
const {
  nextIntervalTickMs,
  nextAnnouncementEligibleBoundaryMs,
  nextAnnouncementSchedulerCheckMs,
  buildAnnouncementWhenItFiresText,
} = createSchedulingHelpers({
  announcementSubdocKeys,
  announcementSubdocDefaultEnabled,
  resolveWeeklyResetStarted: () => getWeeklyResetSchedulerStartedAtMs(),
  resolveWeeklyResetTickMs: () => WEEKLY_RESET_TICK_MS,
  resolveAutoCleanupStarted: () => getAutoCleanupSchedulerStartedAtMs(),
  resolveAutoCleanupTickMs: () => AUTO_CLEANUP_TICK_MS,
  resolveAutoManageStarted: () => getAutoManageSchedulerStartedAtMs(),
  resolveAutoManageDailyTickMs: () => AUTO_MANAGE_DAILY_TICK_MS,
  resolveMaintenanceStarted: () => getMaintenanceSchedulerStartedAtMs(),
  resolveMaintenanceTickMs: () => MAINTENANCE_TICK_MS,
  resolveMaintenanceSlotConfig: () => getMaintenanceSlotConfigSnapshot(),
  resolveWorldEventStarted: () => getWorldEventReminderSchedulerStartedAtMs(),
  resolveWorldEventTickMs: () => WORLD_EVENT_REMINDER_TICK_MS,
  resolveNextWorldEventReminderBoundary: (now) =>
    nextWorldEventReminderBoundaryMs(now) ?? null,
});

const {
  handleRaidHelpCommand,
  handleRaidHelpSelect,
} = createRaidHelpCommand({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  MessageFlags,
  UI,
});

const { handleRaidShareCommand } = createRaidShareCommand({
  EmbedBuilder,
  MessageFlags,
  UI,
});

const { handleStuckNudgeButton } = createStuckNudgeButtonHandler({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
});

const {
  handleRaidLanguageCommand,
  handleRaidLanguageSelect,
} = createRaidLanguageCommand({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  MessageFlags,
  UI,
});

const { handleRaidBgCommand } = createRaidBgCommand({
  User,
  getAccessibleAccounts,
  saveWithRetry,
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
});

const {
  handleRemoveRosterAutocomplete,
  handleRemoveRosterCommand,
} = createRemoveRosterCommand({
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

const {
  handleRaidAnnounceCommand,
  handleRaidAnnounceAutocomplete,
} = createRaidAnnounceCommand({
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

const {
  handleRaidAutoManageCommand,
  handleRaidAutoManageAutocomplete,
} = createRaidAutoManageCommand({
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

const {
  handleRaidTaskCommand,
  handleRaidTaskAutocomplete,
  handleRaidTaskButton,
} = createRaidTaskCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  User,
  saveWithRetry,
  loadUserForAutocomplete,
  loadCachedUserForAutocomplete,
  loadAccessibleAccountsForAutocomplete,
  dailyResetStartMs,
  weekResetStartMs,
});

const {
  handleRaidChannelCommand,
  handleRaidChannelAutocomplete,
} = createRaidChannelCommand({
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
  cleanupAndRefreshRaidChannel,
  getTargetCleanupSlotKey,
});

const RAID_COMMAND_HANDLERS = Object.freeze({
  "raid-add-roster": handleAddRosterCommand,
  "raid-edit-roster": handleEditRosterCommand,
  "raid-check": handleRaidCheckCommand,
  "raid-set": handleRaidSetCommand,
  "raid-status": handleStatusCommand,
  "raid-share": handleRaidShareCommand,
  "raid-language": handleRaidLanguageCommand,
  "raid-bg": handleRaidBgCommand,
  "raid-help": handleRaidHelpCommand,
  "raid-remove-roster": handleRemoveRosterCommand,
  "raid-gold-earner": handleRaidGoldEarnerCommand,
  "raid-channel": handleRaidChannelCommand,
  "raid-auto-manage": handleRaidAutoManageCommand,
  "raid-announce": handleRaidAnnounceCommand,
  "raid-task": handleRaidTaskCommand,
  "raid-auction": handleRaidAuctionCommand,
  "raid-log": handleRaidLogCommand,
  "raid-schedule-preview": handleRaidScheduleCommand,
});

function getRaidCommandDispatchNames() {
  return Object.keys(RAID_COMMAND_HANDLERS);
}

async function handleRaidManagementCommand(interaction) {
  try {
    const handler = RAID_COMMAND_HANDLERS[interaction.commandName];
    if (handler) await handler(interaction);
  } finally {
    await cacheDiscordIdentityForExistingUser(interaction);
  }
}

module.exports = {
  commands,
  handleRaidManagementCommand,
  handleRaidLogComponent,
  handleRaidHelpSelect,
  handleRaidLanguageSelect,
  handleRaidSetAutocomplete,
  handleRemoveRosterAutocomplete,
  handleRaidChannelAutocomplete,
  handleRaidAutoManageAutocomplete,
  handleRaidAnnounceAutocomplete,
  handleRaidTaskAutocomplete,
  handleRaidTaskButton,
  handleRaidScheduleButton,
  handleRaidScheduleSelect,
  handleRaidChannelMessage,
  handleRaidCheckButton,
  handleAddRosterButton,
  handleEditRosterAutocomplete,
  handleEditRosterButton,
  handleRaidGoldEarnerAutocomplete,
  handleRaidGoldEarnerButton,
  handleLocalSyncButton,
  handleLocalSyncRosterSelect,
  applyLocalSyncPreviewJob,
  loadMonitorChannelCache,
  getCachedMonitorChannelId,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
  startMaintenanceScheduler,
  startWorldEventReminderScheduler,
  startSideTaskResetScheduler,
  startRaidScheduleAutoLockScheduler,
  parseRaidMessage,
  handleStuckNudgeButton,
  __test: {
    STATUS_PAGINATION_SESSION_MS,
    RAID_CHECK_PAGINATION_SESSION_MS,
    nextIntervalTickMs,
    nextAnnouncementEligibleBoundaryMs,
    nextAnnouncementSchedulerCheckMs,
    buildAnnouncementWhenItFiresText,
    applyStaleAccountRefreshes,
    formatNextCooldownRemaining,
    buildAccountFreshnessLine,
    ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
    MANAGER_ROSTER_REFRESH_COOLDOWN_MS: require("./services/access/manager").MANAGER_ROSTER_REFRESH_COOLDOWN_MS,
    isManagerId,
    getAutoManageCooldownMs,
    getTargetVNDayKey,
    getCurrentVNHour,
    isInArtistQuietHours,
    hasReachedArtistWakeupBoundary,
    cleanupCountBucket,
    pickBedtimeNoticeContent,
    pickWakeupNoticeContent,
    buildMaintenancePreview,
    getMaintenanceSlotForNow,
    pickMaintenanceVariant,
    buildMaintenanceConfigQuery,
    MAINTENANCE_DAY_VN,
    MAINTENANCE_HOUR_VN,
    MAINTENANCE_MINUTE_VN,
    dailyResetStartMs,
    getRaidCommandDispatchNames,
  },
};
