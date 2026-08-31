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
  buildStatusRosterFilterEntries,
  buildStatusRosterFilterRow,
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
  buildLocalSyncViewEmbed,
  buildLocalSyncViewRows,
  loadLocalSyncSnapshot,
  runLocalSyncViewAction,
} = require("./sync/local-sync-view");
const {
  createStatusComponentRouteHandlers,
} = require("./components/component-handlers");
const {
  createStatusViewerStateLoader,
  probeLocalSyncModeWithBudget,
} = require("./state/viewer-state");
const {
  attachRaidStatusComponentCollector,
} = require("./components/component-collector");
const {
  createRaidStatusComponentSession,
  createRaidStatusSessionState,
} = require("./state/session-state");
const {
  markRaidStatusOpenedDay,
} = require("../../services/auto-manage/runtime/support/daily-backfill");
const {
  createLatestOnlyQueue,
} = require("../../utils/async/latest-only-queue");

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
    commitAutoManageCollected,
    applyAutoManageCollectedForStatus,
    stampAutoManageAttempt,
    weekResetStartMs,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    getAutoManageCooldownMs,
    getRosterRefreshCooldownMs,
    applyRaidSetForDiscordId = null,
    applyRaidSetBatchForDiscordId = null,
    PreviewModel = null,
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
  });

  const {
    buildStatusUserMeta,
    prepareStatusUserDoc,
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
    commitAutoManageCollected,
    applyAutoManageCollectedForStatus,
    stampAutoManageAttempt,
    weekResetStartMs,
    STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS,
  });

  // `alreadyDeferred` lets a durable Local Sync button flow hand its existing
  // message to the canonical status session. Keeping the
  // collector, state, renderer, and component layout here avoids a second UI
  // implementation drifting away from /raid-status.
  async function handleStatusCommand(interaction, options = {}) {
    const started = Date.now();
    const discordId = interaction.user.id;
    const alreadyDeferred = options?.alreadyDeferred === true;
    const initialContent = options?.content ?? null;
    // Durable Local Sync buttons hand off here with initialView "sync" so the
    // settled result renders inside the canonical status frame.
    const initialView = options?.initialView === "sync" ? "sync" : "raid";
    // Probe localSyncEnabled before defer to mark the reply as
    // ephemeral when local-sync is on. The Mở Web Companion Link button
    // carries a signed token URL in its href - public messages would
    // leak that URL to anyone in the channel who clicks it (Link
    // buttons bypass bot auth). Ephemeral keeps the URL opener-only.
    // Start the viewer snapshot and share lookup at the same time. The
    // lean seed is reused for the privacy probe, locale, and first render,
    // avoiding repeated Mongo round-trips for the same viewer.
    const viewerStateLoader = createStatusViewerStateLoader({
      User,
      discordId,
      prepareStatusUserDoc,
    });
    if (!alreadyDeferred) {
      const isLocalSyncMode = await probeLocalSyncModeWithBudget({
        probePromise: viewerStateLoader.probeLocalSyncMode(),
        waitWithBudget,
      });
      await interaction.deferReply(
        isLocalSyncMode ? { flags: MessageFlags.Ephemeral } : {}
      );
    }
    const ackMs = Date.now() - started;
    const viewerState = await viewerStateLoader.load();
    const viewerReadyAt = Date.now();
    const {
      lang,
      incomingSharedAccounts,
      piggybackOutcome,
      startBackgroundRefresh,
    } = viewerState;
    let userDoc = viewerState.userDoc;

    if (viewerState.noRoster) {
      await interaction.editReply({
        content: initialContent,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-status.notice.noRosterTitle", lang),
            description: t("raid-status.notice.noRosterDescription", lang),
          }),
        ],
        files: [],
        attachments: [],
        components: [],
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
      buildStatusRosterFilterEntries,
      initialView,
    });
    const stateReadyAt = Date.now();

    // Merge in accounts shared from manager-A users (RAID_MANAGER_ID
    // allowlist) so /raid-status renders both B's own rosters AND any
    // rosters A has granted to B via /raid-share grant. Shared accounts
    // carry an `_sharedFrom` tag the view layer reads to badge the page
    // title with "Shared by Alice" and skip auto-manage badges B has no
    // control over.
    let statusUserMeta = buildStatusUserMeta(userDoc, piggybackOutcome);
    let backgroundRefreshing = typeof startBackgroundRefresh === "function";

    // Reloading rebuilds both raid aggregates and roster navigation while
    // keeping the page index tied to the underlying merged account list.
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
    // at least one task on the account. Without account scoping, rosters
    // with > 25 total tasks (4+ chars × cap 8)
    // would silently drop tail entries from the toggle dropdown.
    const {
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
      buildGoldModeRow,
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

    // Local Sync view. Its data needs three awaits (user doc, newest
    // preview job, signed reader URL) while both raid-status render
    // paths are synchronous, so the snapshot is fetched here and by the
    // async component handler, then parked on session state.
    const refreshLocalSyncSnapshot = async ({ jobId = "" } = {}) =>
      loadLocalSyncSnapshot({
        discordUser: interaction.user,
        userDoc: statusState.userDoc,
        User,
        PreviewModel,
        lang,
        jobId,
      });

    const runLocalSyncAction = ({ action, jobId }) =>
      runLocalSyncViewAction({
        action,
        jobId,
        discordId,
        User,
        PreviewModel,
        applyRaidSetForDiscordId,
        applyRaidSetBatchForDiscordId,
        acquireAutoManageSyncSlot,
        releaseAutoManageSyncSlot,
      });

    const localSyncViewDeps = {
      lang,
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      StringSelectMenuBuilder,
      truncateText,
      UI,
      formatGold,
    };
    const buildSyncViewEmbed = () => buildLocalSyncViewEmbed({
      snapshot: statusState.localSyncSnapshot,
      rosterFilter: statusState.localSyncRosterFilter,
      ...localSyncViewDeps,
    });
    const buildSyncViewRows = (disabled) => buildLocalSyncViewRows({
      snapshot: statusState.localSyncSnapshot,
      rosterFilter: statusState.localSyncRosterFilter,
      disabled,
      ...localSyncViewDeps,
    });

    if (initialView === "sync") {
      statusState.localSyncSnapshot = await refreshLocalSyncSnapshot();
    }

    const {
      buildCurrentEmbed,
      buildEmbedAndCanvas,
    } = createRaidStatusRenderPayload({
      discordId,
      getAccounts: () => statusState.accounts,
      getCurrentPage: () => statusState.currentPage,
      getCurrentLocalPage: () => statusState.currentLocalPage,
      getVisibleRosterCount: () => statusState.visibleRosterCount,
      getCurrentView: () => statusState.currentView,
      getFilterRaidId: () => statusState.filterRaidId,
      getStatusUserMeta: () => statusUserMeta,
      baseGetRaidsFor: statusState.baseGetRaidsFor,
      getTotalCharacters: () => statusState.totalCharacters,
      summarizeRaidProgress,
      summarizeGlobalGold,
      buildAccountPageEmbed,
      buildGoldViewEmbed,
      buildTaskViewEmbed,
      buildLocalSyncViewEmbed: buildSyncViewEmbed,
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

    // Local-sync token and personal raid events hydrate after the first render;
    // their controls appear in this same message when the reads finish.
    let myRaidsShaped = [];

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
      buildGoldModeRow,
      buildGoldToggleRow,
      buildSyncButton: syncControls.buildSyncButton,
      buildSyncRow: syncControls.buildSyncRow,
      buildLocalSyncNewButton: syncControls.buildLocalSyncNewButton,
      buildLocalSyncRefreshButton: syncControls.buildLocalSyncRefreshButton,
      buildRosterRefreshButton: syncControls.buildRosterRefreshButton,
      buildSoloCompanionButton: syncControls.buildSoloCompanionButton,
      buildRaidFilterRow,
      buildStatusRosterFilterRow,
      buildMyRaidsRow,
      buildLocalSyncViewRows: buildSyncViewRows,
      getAccounts: () => statusState.accounts,
      getCurrentPage: () => statusState.currentPage,
      getCurrentLocalPage: () => statusState.currentLocalPage,
      getVisibleRosterCount: () => statusState.visibleRosterCount,
      getCurrentView: () => statusState.currentView,
      getStatusUserMeta: () => statusUserMeta,
      getRaidDropdownEntries: () => statusState.raidDropdownEntries,
      getTotalRaidPending: () => statusState.totalRaidPending,
      getTotalSoloPending: () => statusState.totalSoloPending,
      getFilterRaidId: () => statusState.filterRaidId,
      getRosterFilterEntries: () => statusState.rosterFilterEntries,
      getSelectedRosterIndex: () => statusState.selectedRosterIndex,
      getMyRaidsShaped: () => myRaidsShaped,
      getBackgroundRefreshing: () => backgroundRefreshing,
    });

    const firstRenderStarted = Date.now();
    const initialComponents = buildComponents(false);

    const messageFromEdit = await interaction.editReply({
      content: initialContent,
      embeds: [buildCurrentEmbed()],
      files: [],
      attachments: [],
      components: initialComponents,
    });
    console.log(
      `[raid-status] rendered accounts=${statusState.accounts.length} ackMs=${ackMs} postAckViewerMs=${Math.max(0, viewerReadyAt - started - ackMs)} stateMs=${stateReadyAt - viewerReadyAt} firstRenderMs=${Date.now() - firstRenderStarted} openMs=${Date.now() - started}`
    );

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
      ButtonBuilder,
      ButtonStyle,
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
      refreshLocalSyncSnapshot,
      runLocalSyncAction,
    });

    const message = messageFromEdit?.createMessageComponentCollector
      ? messageFromEdit
      : await interaction.fetchReply();
    const attachedCollector = attachRaidStatusComponentCollector({
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
      refreshStateIfStale: () => statusState.refreshViewerAccountsIfStale(),
    });

    const backgroundRenderQueue = createLatestOnlyQueue(
      async () => {
        if (attachedCollector.isEnded()) return;
        const payload = await buildEmbedAndCanvas();
        if (attachedCollector.isEnded()) return;
        await interaction.editReply({
          ...payload,
          components: buildComponents(false),
        });
      },
      {
        onError: (err, labels) => {
          console.warn(
            `[raid-status] ${labels.join("+") || "update"} background render failed:`,
            err?.message || err
          );
        },
      }
    );
    const queueBackgroundRender = (label) => backgroundRenderQueue.request(label);

    void markRaidStatusOpenedDay({
      User,
      discordId,
      lastOpenedDayKey: userDoc?.lastRaidStatusOpenedDayKey,
    }).catch((err) => {
      console.warn("[raid-status] daily activity stamp failed:", err?.message || err);
    });

    if (backgroundRefreshing) {
      const refreshStarted = Date.now();
      void startBackgroundRefresh()
        .then(async (refreshed) => {
          if (refreshed?.userDoc) {
            await reloadViewerAccounts(refreshed.userDoc);
            statusUserMeta = buildStatusUserMeta(
              refreshed.userDoc,
              refreshed.piggybackOutcome
            );
          }
          backgroundRefreshing = false;
          console.log(
            `[raid-status] background refresh ms=${Date.now() - refreshStarted} outcome=${refreshed?.piggybackOutcome?.outcome || "unknown"}`
          );
          return queueBackgroundRender("refresh");
        })
        .catch((err) => {
          backgroundRefreshing = false;
          console.warn("[raid-status] background refresh failed:", err?.message || err);
          return queueBackgroundRender("refresh-failed");
        });
    }

    const extrasStarted = Date.now();
    const localSyncHydration = statusUserMeta.localSyncEnabled
      ? syncControls.hydrateLocalSyncResumeUrl(interaction.user)
      : Promise.resolve();
    const myRaidsHydration = findActiveEventsForUser({
      RaidEvent,
      guildId: interaction.guildId,
      discordId: interaction.user.id,
    }).then((events) => {
      myRaidsShaped = shapeMyRaidEvents(events, interaction.user.id);
    });
    void Promise.all([localSyncHydration, myRaidsHydration])
      .then(() => {
        console.log(
          `[raid-status] background extras raids=${myRaidsShaped.length} ms=${Date.now() - extrasStarted}`
        );
        return queueBackgroundRender("extras");
      })
      .catch((err) => {
        console.warn("[raid-status] background extras failed:", err?.message || err);
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
