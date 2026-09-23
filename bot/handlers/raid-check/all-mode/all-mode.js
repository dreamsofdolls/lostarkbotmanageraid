"use strict";

const {
  buildNoticeEmbed,
  deferEphemeralReply,
  editNotice,
  UI,
} = require("../../../utils/raid/common/shared");
// tPick, not t: the refresh and sync titles are variant pools; other keys pass through.
const { tPick: t, getUserLanguage } = require("../../../services/i18n");
const { createTeamsViewUi } = require("../views/teams-view");
const {
  createAllModePendingAggregateCache,
} = require("./all-mode-aggregate");
const {
  FILTER_ALL,
  FILTER_STATUS,
  filterAllModePageIndices,
  resolveAllModeLocalPage,
} = require("./all-mode-filters");
const {
  buildAllModePagesData,
  createAllModeRefreshIndex,
  loadAllModeUsers,
  resolveAllModeAuthorMeta,
} = require("./all-mode-data");
const {
  createAllModePageRenderers,
} = require("./all-mode-render");
const {
  getRaidCheckAllComponentRoute,
} = require("./all-mode-routes");
const {
  createAllModeViewBuilders,
} = require("./all-mode-view");
const {
  createAllModeComponentHandlers,
} = require("./all-mode-component-handlers");
const {
  createLatestOnlyQueue,
} = require("../../../utils/async/latest-only-queue");

function createAllModeHandler({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  User,
  ensureFreshWeek,
  truncateText,
  buildAccountPageEmbed,
  buildStatusFooterText,
  summarizeRaidProgress,
  getStatusRaidsForCharacter,
  buildPaginationRow,
  isRaidLeader,
  raidCheckRefreshLimiter,
  loadFreshUserSnapshotForRaidViews,
  shouldLoadFreshUserSnapshotForRaidViews,
  runManualRosterRefresh,
  RAID_CHECK_USER_QUERY_FIELDS,
  RAID_CHECK_PAGINATION_SESSION_MS,
  RaidEvent,
  buildScheduleEmbed,
  buildTurnPlanEmbed,
}) {
  const teamsView = createTeamsViewUi({
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    RaidEvent,
    User,
    buildScheduleEmbed,
    buildTurnPlanEmbed,
    truncateText,
  });

  async function handleRaidCheckAllCommand(interaction) {
    const started = Date.now();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ackMs = Date.now() - started;
    const langPromise = getUserLanguage(interaction.user.id, { UserModel: User });
    if (!isRaidLeader(interaction)) {
      const lang = await langPromise;
      await interaction.editReply({
        content: null,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: t("raid-check.auth.managerOnlyTitle", lang),
            description: t("raid-check.auth.managerOnlyDescription", lang),
          }),
        ],
      });
      return;
    }

    const dataLoadStarted = Date.now();
    const [lang, allModeUsers] = await Promise.all([
      langPromise,
      loadAllModeUsers({
        User,
        ensureFreshWeek,
        RAID_CHECK_USER_QUERY_FIELDS,
        raidCheckRefreshLimiter,
        loadFreshUserSnapshotForRaidViews,
        shouldLoadFreshUserSnapshotForRaidViews,
      }),
    ]);
    const dataReadyAt = Date.now();
    const dataLoadMs = dataReadyAt - dataLoadStarted;
    const {
      users,
      refreshQueued,
      freshBypass,
      canRefreshFreshData,
      startBackgroundRefresh,
    } = allModeUsers;
    if (canRefreshFreshData) {
      console.log(
        `[raid-check all] refreshQueued=${refreshQueued} freshBypass=${freshBypass}`
      );
    }

    const pagesData = buildAllModePagesData(users);
    if (pagesData.length === 0) {
      await interaction.editReply({
        content: null,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-check.notice.noRosterTitle", lang),
            description: t("raid-check.notice.noRosterDescription", lang),
          }),
        ],
      });
      return;
    }

    const {
      visibleUserIds,
      authorMeta,
      refreshIncompleteAuthorMeta,
    } = resolveAllModeAuthorMeta({ interaction, users, pagesData });
    const totalPages = pagesData.length;
    const autoManageStateByDiscordId = new Map();
    const localSyncStateByDiscordId = new Map();
    for (const page of pagesData) {
      const id = page.userDoc?.discordId;
      if (!id || autoManageStateByDiscordId.has(id)) continue;
      autoManageStateByDiscordId.set(id, !!page.userDoc.autoManageEnabled);
      localSyncStateByDiscordId.set(id, !!page.userDoc.localSyncEnabled);
    }

    // Shared mutable session state: filters, paging and background flags
    // are read fresh by the view builders and collector handlers.
    const state = {
      filterUserId: null,
      filterRosterIndex: null,
      filterRaidId: null,
      filterStatus: FILTER_STATUS.all,
      filteredIndices: [],
      currentLocalPage: 0,
      backgroundRefreshing: refreshQueued > 0,
      teamsSnapshot: [],
      sessionEnded: false,
    };

    const currentAbsoluteIndex = () =>
      state.filteredIndices[state.currentLocalPage] ?? state.filteredIndices[0] ?? null;
    const getRenderState = () => ({
      currentLocalPage: state.currentLocalPage,
      filterRaidId: state.filterRaidId,
      filterStatus: state.filterStatus,
      filteredIndices: state.filteredIndices,
    });
    const pendingAggregateCache = createAllModePendingAggregateCache({
      pagesData,
      getStatusRaidsForCharacter,
      lang,
    });
    const { applyRefreshedUserDoc } = createAllModeRefreshIndex(users, pagesData);
    const { buildRaidPage } = createAllModePageRenderers({
      authorMeta,
      buildAccountPageEmbed,
      buildStatusFooterText,
      getState: getRenderState,
      getStatusRaidsForCharacter: pendingAggregateCache.getRaidsForCharacter,
      lang,
      pagesData,
      summarizeRaidProgress,
      truncateText,
    });
    const renderEmbed = (pageIndex) => {
      if (!Number.isInteger(pageIndex)) {
        return buildNoticeEmbed(EmbedBuilder, {
          type: "info",
          title: t("raid-check.notice.noFilterMatchesTitle", lang),
          description: t("raid-check.notice.noFilterMatchesDescription", lang),
        });
      }
      return buildRaidPage(pageIndex);
    };

    const recomputeFilteredPages = ({ resetPage = true } = {}) => {
      const previousLocalPage = state.currentLocalPage;
      const result = filterAllModePageIndices({
        pagesData,
        filterUserId: state.filterUserId,
        filterRosterIndex: state.filterRosterIndex,
        filterRaidId: state.filterRaidId,
        filterStatus: state.filterStatus,
        getStatusRaidsForCharacter: pendingAggregateCache.getRaidsForCharacter,
      });
      state.filteredIndices = result.filteredIndices;
      state.filterRosterIndex = result.filterRosterIndex;
      state.currentLocalPage = resolveAllModeLocalPage({
        filteredIndices: state.filteredIndices,
        filterRosterIndex: state.filterRosterIndex,
        currentLocalPage: previousLocalPage,
        resetPage,
      });
    };
    // The first view follows the same page rules as a filter change.
    recomputeFilteredPages();

    const applyUserFilter = (pickedValue) => {
      state.filterUserId = pickedValue === FILTER_ALL ? null : pickedValue;
      state.filterRosterIndex = null;
      recomputeFilteredPages();
    };

    const computePendingAggregate = ({ raidFilter, userFilter }) =>
      pendingAggregateCache.compute({ raidFilter, userFilter });

    const { buildComponents } = createAllModeViewBuilders({
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      StringSelectMenuBuilder,
      t,
      lang,
      truncateText,
      authorMeta,
      visibleUserIds,
      pagesData,
      autoManageStateByDiscordId,
      localSyncStateByDiscordId,
      computePendingAggregate,
      getRaidsForCharacter: pendingAggregateCache.getRaidsForCharacter,
      buildPaginationRow,
      teamsView,
      state,
      currentAbsoluteIndex,
    });

    const backgroundRenderQueue = createLatestOnlyQueue(
      async () => {
        if (state.sessionEnded) return;
        await interaction.editReply({
          embeds: [renderEmbed(currentAbsoluteIndex())],
          components: buildComponents(false),
        });
      },
      {
        onError: (err, labels) => {
          console.warn(
            `[raid-check all] ${labels.join("+") || "update"} background render failed:`,
            err?.message || err
          );
        },
      }
    );
    const queueBackgroundRender = (label) => backgroundRenderQueue.request(label);

    const firstRenderStarted = Date.now();
    const followup = await interaction.editReply({
      embeds: [renderEmbed(currentAbsoluteIndex())],
      components: buildComponents(false),
    });
    console.log(
      `[raid-check all] rendered pages=${totalPages} users=${visibleUserIds.length} ackMs=${ackMs} dataLoadMs=${dataLoadMs} prepareMs=${firstRenderStarted - dataReadyAt} firstRenderMs=${Date.now() - firstRenderStarted} openMs=${Date.now() - started}`
    );

    const allModeComponentHandlers = createAllModeComponentHandlers({
      EmbedBuilder,
      lang,
      interaction,
      pagesData,
      state,
      teamsView,
      runManualRosterRefresh,
      applyUserFilter,
      recomputeFilteredPages,
      currentAbsoluteIndex,
      renderEmbed,
      buildComponents,
      pendingAggregateCache,
      applyRefreshedUserDoc,
    });

    const collector = followup.createMessageComponentCollector({
      time: RAID_CHECK_PAGINATION_SESSION_MS,
    });
    collector.on("collect", async (component) => {
      const route = getRaidCheckAllComponentRoute(component.customId, {
        teamsSelectPrefix: teamsView.TEAMS_SELECT_PREFIX,
      });
      if (component.user.id !== interaction.user.id) {
        if (route) {
          const deferred = await deferEphemeralReply(component)
            .then(() => true)
            .catch(() => false);
          if (!deferred) return;
          const clickerLang = await getUserLanguage(component.user.id, { UserModel: User });
          await editNotice(component, EmbedBuilder, {
            type: "lock",
            title: t("raid-check.notice.sessionLockTitle", clickerLang),
            description: t("raid-check.notice.sessionLockDescription", clickerLang),
          }).catch(() => {});
        }
        return;
      }
      if (!route) return;
      const handler = allModeComponentHandlers[route.action];
      if (handler) await handler(component, route);
    });
    collector.on("end", async () => {
      state.sessionEnded = true;
      await backgroundRenderQueue.flush();
      await followup
        .edit({ components: buildComponents(true) })
        .catch(() => {});
    });

    void refreshIncompleteAuthorMeta()
      .then((refreshed) => {
        if (refreshed <= 0) return null;
        console.log(`[raid-check all] author metadata refreshed=${refreshed}`);
        return queueBackgroundRender("author-meta");
      })
      .catch((err) => {
        console.warn(
          "[raid-check all] author-name refresh failed:",
          err?.message || err
        );
      });

    if (typeof startBackgroundRefresh === "function" && refreshQueued > 0) {
      const refreshStarted = Date.now();
      let published = 0;
      void startBackgroundRefresh({
        onUserRefreshed: (userDoc) => {
          if (!applyRefreshedUserDoc(userDoc)) return;
          published += 1;
          pendingAggregateCache.clear();
          recomputeFilteredPages({ resetPage: false });
          queueBackgroundRender("roster-refresh-partial");
        },
      })
        .then((refreshedUsers) => {
          state.backgroundRefreshing = false;
          console.log(
            `[raid-check all] background refresh published=${published}/${refreshQueued} jobsCompleted=${refreshedUsers?.length || 0} ms=${Date.now() - refreshStarted}`
          );
          return queueBackgroundRender("roster-refresh-complete");
        })
        .catch((err) => {
          state.backgroundRefreshing = false;
          console.warn("[raid-check all] background refresh failed:", err?.message || err);
          return queueBackgroundRender("roster-refresh-failed");
        });
    }

    const teamsStarted = Date.now();
    void teamsView
      .loadActiveEventsForTeams({
        guildId: interaction.guildId || interaction.guild?.id,
      })
      .then((rows) => {
        state.teamsSnapshot = Array.isArray(rows) ? rows : [];
        console.log(
          `[raid-check all] background teams=${state.teamsSnapshot.length} ms=${Date.now() - teamsStarted}`
        );
        if (state.teamsSnapshot.length > 0) return queueBackgroundRender("teams");
        return null;
      })
      .catch((err) => {
        console.warn("[raid-check all] background teams failed:", err?.message || err);
      });
  }

  return { handleRaidCheckAllCommand };
}

module.exports = { createAllModeHandler };
