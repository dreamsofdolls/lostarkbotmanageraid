/**
 * handlers/raid-status/index.js
 * Compose root for /raid-status. Wires the view layer + task UI +
 * sync (auto-manage piggyback + fresh-roster refresh) + filter into
 * one handler bag dispatched from commands.js. Owns the timer that
 * keeps the per-session sync slot from leaking when a user closes
 * the embed.
 */

const { createRaidStatusView } = require("./view/view");
const { createRaidStatusTaskUi } = require("./task/task-ui");
const { createRaidStatusGoldUi } = require("./gold/gold-ui");
const { createRaidStatusSync } = require("./sync/sync");
const { createRaidStatusComponentLayout } = require("./components/component-layout");
const { createRaidStatusRenderPayload } = require("./view/render-payload");
const {
  buildRaidDropdownState,
  buildRaidFilterRow,
} = require("./raid-filter");
const {
  findActiveEventsForUser,
  buildMyRaidsRow,
  buildMyRaidDetailEmbed,
} = require("./my-raids");
const { shapeMyRaidEvents } = require("../../services/raid/schedule/boards/my-raids");
const RaidEvent = require("../../models/RaidEvent");
const {
  buildNoticeEmbed,
} = require("../../utils/raid/common/shared");
const { t } = require("../../services/i18n");
const {
  buildMergedAccounts,
  resolveBackgroundLookup,
} = require("./view/accounts");
const {
  createRaidStatusSyncControls,
} = require("./sync/sync-controls");
const {
  createStatusComponentRouteHandlers,
} = require("./components/component-handlers");
const {
  loadStatusViewerState,
  probeLocalSyncModeWithBudget,
} = require("./state/viewer-state");
const {
  attachRaidStatusComponentCollector,
} = require("./components/component-collector");
const {
  createRaidStatusComponentSession,
  createRaidStatusSessionState,
} = require("./state/session-state");

const STATUS_PAGINATION_SESSION_MS = 10 * 60 * 1000;
const STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS = 2500;
const STATUS_TASK_AUTO_REFRESH_GRACE_MS = 1000;

/**
 * Build the /raid-status command handler factory.
 * @param {object} deps - injected dependencies (discord.js builders +
 *   MessageFlags, Mongoose User + saveWithRetry, RosterShare,
 *   auto-manage service handles, refresh service, view/task UI/sync
 *   sub-factories, raid catalogue · see destructure block).
 * @returns {object} service surface · see the return literal for the
 *   canonical handler list (handleStatusCommand + every paginate/
 *   filter/task-action/sync button + select dispatch entry).
 */
function createRaidStatusCommand(deps) {
  const {
    EmbedBuilder,
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
    applyAutoManageCollectedForStatus,
    syncRaidProfileFromBibleCollected,
    stampAutoManageAttempt,
    weekResetStartMs,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    getAutoManageCooldownMs,
    getRosterRefreshCooldownMs,
    isManagerId,
  } = deps;

  const {
    buildAccountFreshnessLine,
    buildAccountPageEmbed,
    buildStatusFooterText,
  } = createRaidStatusView({
    EmbedBuilder,
    UI,
    getCharacterName,
    truncateText,
    formatNextCooldownRemaining,
    summarizeRaidProgress,
    summarizeAccountGold,
    formatGold,
    formatRaidStatusLine,
    formatRosterRefreshCooldownRemaining,
    ROSTER_REFRESH_COOLDOWN_MS,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    getAutoManageCooldownMs,
    getRosterRefreshCooldownMs,
    isManagerId,
  });

  const {
    buildStatusUserMeta,
    loadStatusUserDoc,
    runManualStatusSync,
  } = createRaidStatusSync({
    User,
    saveWithRetry,
    ensureFreshWeek,
    collectStaleAccountRefreshes,
    applyStaleAccountRefreshes,
    waitWithBudget,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    applyAutoManageCollectedForStatus,
    syncRaidProfileFromBibleCollected,
    stampAutoManageAttempt,
    weekResetStartMs,
    STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS,
  });

  async function handleStatusCommand(interaction) {
    const discordId = interaction.user.id;
    // Probe localSyncEnabled BEFORE defer so we can flag the reply as
    // ephemeral when local-sync is on. The Mở Web Companion Link button
    // carries a signed token URL in its href - public messages would
    // leak that URL to anyone in the channel who clicks it (Link
    // buttons bypass bot auth). Ephemeral keeps the URL opener-only.
    // Lean+select is ~30ms - well under Discord's 3-sec defer deadline.
    const isLocalSyncMode = await probeLocalSyncModeWithBudget({
      User,
      discordId,
      waitWithBudget,
    });
    await interaction.deferReply(
      isLocalSyncMode ? { flags: MessageFlags.Ephemeral } : {}
    );
    const viewerState = await loadStatusViewerState({
      User,
      discordId,
      loadStatusUserDoc,
    });
    const {
      lang,
      hasIncomingShare,
      incomingSharedAccounts,
      piggybackOutcome,
    } = viewerState;
    let userDoc = viewerState.userDoc;

    if (viewerState.noRoster) {
      await interaction.editReply({
        content: null,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-status.notice.noRosterTitle", lang),
            description: t("raid-status.notice.noRosterDescription", lang),
          }),
        ],
      });
      return;
    }

    const statusState = await createRaidStatusSessionState({
      User,
      discordId,
      userDoc,
      incomingSharedAccounts,
      buildMergedAccounts,
      getStatusRaidsForCharacter,
      buildRaidDropdownState,
    });

    // Merge in accounts shared from manager-A users (RAID_MANAGER_ID
    // allowlist) so /raid-status renders both B's own rosters AND any
    // rosters A has granted to B via /raid-share grant. Shared accounts
    // carry an `_sharedFrom` tag the view layer reads to badge the page
    // title with "Shared by Alice" and skip auto-manage badges B has no
    // control over.
    let statusUserMeta = buildStatusUserMeta(userDoc, piggybackOutcome);

    // Raid-filter aggregate for the caller's own roster. Parallel to the
    // all-mode dropdown in /raid-check, but counts here are
    // self-scoped (chars across caller's accounts where the raid isn't
    // fully cleared yet). Computed once at init with the unfiltered
    // getRaidsFor so toggling filters later doesn't rewrite the labels
    // underneath the user's hand - labels stay as a stable "my backlog
    // per raid" reference. Sorted pending desc so the heaviest backlog
    // surfaces first.
    // Per-raid entries also track {supports, dps} so the dropdown label
    // can render "Aegir Hard (3 pending · 1🛡️ 2⚔️)" - lets the caller see
    // at a glance whether a raid's backlog is composition-blocking (no
    // supports left) or just queue depth. Hard-support classes are Bard
    // / Paladin / Artist / Valkyrie; everyone else counts as DPS.
    const reloadViewerAccounts = async (nextOwnDoc = null) => {
      userDoc = await statusState.reloadViewerAccounts(nextOwnDoc);
    };

    // View toggle: "raid" = default progress page, "task" = per-character
    // side-task list (registered via /raid-task). Dropdown swaps the embed
    // body + the third action row but keeps pagination semantics so the
    // user stays on the same account when toggling views.
    // Char filter for Task view's toggle dropdown. Stored per-page (Map
    // keyed by currentPage) so navigating across accounts doesn't lose
    // the user's per-account char focus. null = "auto-pick first char
    // with tasks" so the toggle dropdown is always populated when there's
    // at least one task on the account. Codex round 28 finding #2:
    // without scoping, accounts with > 25 total tasks (4+ chars × cap 8)
    // would silently drop tail entries from the toggle dropdown.
    const {
      ALL_CHARS_SENTINEL,
      buildTaskViewEmbed,
      buildViewToggleRow,
      buildSharedTaskToggleRow,
      buildTaskCharFilterRow,
      buildTaskToggleRow,
    } = createRaidStatusTaskUi({
      EmbedBuilder,
      ActionRowBuilder,
      StringSelectMenuBuilder,
      UI,
      getCharacterName,
      truncateText,
      getAccounts: () => statusState.accounts,
      getCurrentPage: () => statusState.currentPage,
      getCurrentView: () => statusState.currentView,
      getTaskCharFilter: (page) => statusState.getTaskCharFilter(page),
      lang,
    });

    const {
      buildGoldViewEmbed,
      buildGoldCharFilterRow,
      buildGoldToggleRow,
    } = createRaidStatusGoldUi({
      EmbedBuilder,
      ActionRowBuilder,
      StringSelectMenuBuilder,
      UI,
      getCharacterName,
      truncateText,
      formatGold,
      getAccounts: () => statusState.accounts,
      getCurrentPage: () => statusState.currentPage,
      getGoldCharFilter: (page) => statusState.getGoldCharFilter(page),
      getRaidsFor: statusState.baseGetRaidsFor,
      lang,
    });

    const {
      buildCurrentEmbed,
      buildEmbedAndCanvas,
    } = createRaidStatusRenderPayload({
      discordId,
      getAccounts: () => statusState.accounts,
      getCurrentPage: () => statusState.currentPage,
      getCurrentView: () => statusState.currentView,
      getFilterRaidId: () => statusState.filterRaidId,
      getStatusUserMeta: () => statusUserMeta,
      baseGetRaidsFor: statusState.baseGetRaidsFor,
      totalCharacters: statusState.totalCharacters,
      summarizeRaidProgress,
      summarizeGlobalGold,
      buildAccountPageEmbed,
      buildGoldViewEmbed,
      buildTaskViewEmbed,
      lang,
    });

    // Sync controls own auto-manage cooldown labels plus local-sync resume,
    // rotate, and refresh buttons. Keep the mutable URL cache inside the
    // control service so component handlers can update it after rotation.
    const syncControls = createRaidStatusSyncControls({
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      User,
      discordId,
      lang,
      formatNextCooldownRemaining,
      getAutoManageCooldownMs,
      AUTO_MANAGE_SYNC_COOLDOWN_MS,
      getStatusUserMeta: () => statusUserMeta,
    });

    // A second "🆕 New link" Primary button rotates - clicked, mints
    await syncControls.hydrateLocalSyncResumeUrl(interaction.user);

    // "Raid của tôi": active raid-schedule events this viewer is signed up
    // for (self-join or manager-added), guild-wide. Shaped once; the dropdown
    // is the same on every page (it is viewer-global, not per-account).
    const myRaidEvents = await findActiveEventsForUser({
      RaidEvent,
      guildId: interaction.guildId,
      discordId: interaction.user.id,
    });
    const myRaidsShaped = shapeMyRaidEvents(myRaidEvents, interaction.user.id);

    const { buildComponents } = createRaidStatusComponentLayout({
      ActionRowBuilder,
      StringSelectMenuBuilder,
      truncateText,
      lang,
      buildPaginationRow,
      buildViewToggleRow,
      buildSharedTaskToggleRow,
      buildTaskCharFilterRow,
      buildTaskToggleRow,
      buildGoldCharFilterRow,
      buildGoldToggleRow,
      buildSyncButton: syncControls.buildSyncButton,
      buildSyncRow: syncControls.buildSyncRow,
      buildLocalSyncNewButton: syncControls.buildLocalSyncNewButton,
      buildLocalSyncRefreshButton: syncControls.buildLocalSyncRefreshButton,
      buildRosterRefreshButton: syncControls.buildRosterRefreshButton,
      buildRaidFilterRow,
      buildMyRaidsRow,
      getAccounts: () => statusState.accounts,
      getCurrentPage: () => statusState.currentPage,
      getCurrentView: () => statusState.currentView,
      getStatusUserMeta: () => statusUserMeta,
      getRaidDropdownEntries: () => statusState.raidDropdownEntries,
      getTotalRaidPending: () => statusState.totalRaidPending,
      getFilterRaidId: () => statusState.filterRaidId,
      getMyRaidsShaped: () => myRaidsShaped,
    });

    const initialComponents = buildComponents(false);

    await interaction.editReply({
      ...(await buildEmbedAndCanvas()),
      components: initialComponents,
    });

    // No interactive surface (single account + no eligible raids) - skip
    // the collector entirely. Without this guard the collector would
    // spin for STATUS_PAGINATION_SESSION_MS doing nothing.
    if (initialComponents.length === 0) return;

    const componentSession = createRaidStatusComponentSession({
      state: statusState,
      getStatusUserMeta: () => statusUserMeta,
      setStatusUserMeta: (value) => {
        statusUserMeta = value;
      },
      syncControls,
    });

    const componentRouteHandlers = createStatusComponentRouteHandlers({
      session: componentSession,
      EmbedBuilder,
      ActionRowBuilder,
      StringSelectMenuBuilder,
      UI,
      User,
      saveWithRetry,
      interaction,
      discordId,
      lang,
      buildStatusUserMeta,
      reloadViewerAccounts,
      buildEmbedAndCanvas,
      buildComponents,
      runManualStatusSync,
      runManualRosterRefresh,
      formatNextCooldownRemaining,
      formatGold,
      truncateText,
      getAutoManageCooldownMs,
      AUTO_MANAGE_SYNC_COOLDOWN_MS,
      buildMyRaidDetailEmbed,
    });

    const message = await interaction.fetchReply();
    attachRaidStatusComponentCollector({
      EmbedBuilder,
      User,
      interaction,
      message,
      lang,
      sessionMs: STATUS_PAGINATION_SESSION_MS,
      taskAutoRefreshGraceMs: STATUS_TASK_AUTO_REFRESH_GRACE_MS,
      getAccounts: () => statusState.accounts,
      getCurrentPage: () => statusState.currentPage,
      getCurrentView: () => statusState.currentView,
      buildCurrentEmbed,
      buildEmbedAndCanvas,
      buildComponents,
      componentRouteHandlers,
    });
  }

  return {
    handleStatusCommand,
    buildAccountFreshnessLine,
    buildAccountPageEmbed,
    buildStatusFooterText,
  };
}

module.exports = {
  createRaidStatusCommand,
  STATUS_PAGINATION_SESSION_MS,
  STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS,
  _resolveBackgroundLookup: resolveBackgroundLookup,
};
