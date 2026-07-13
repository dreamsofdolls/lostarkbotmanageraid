"use strict";

const {
  buildNoticeEmbed,
  deferEphemeralReply,
  editNotice,
  followUpNotice,
  replyNotice,
  UI,
} = require("../../../utils/raid/common/shared");
const { firstSelectValue } = require("../../../utils/discord/component-values");
const { t, getUserLanguage } = require("../../../services/i18n");
const { createTeamsViewUi } = require("../views/teams-view");
const {
  createAllModePendingAggregateCache,
} = require("./all-mode-aggregate");
const {
  addAllModeActionButtons,
  buildAllModeRosterRefreshRow,
} = require("./all-mode-buttons");
const {
  FILTER_ALL,
  FILTER_ALL_RAIDS,
  FILTER_STATUS,
  buildAllModeRaidFilterRow,
  buildAllModeStatusFilterRow,
  buildAllModeUserFilterRow,
  normalizeAllModeStatusFilter,
} = require("./all-mode-filters");
const {
  buildAllModePagesData,
  loadAllModeUsers,
  resolveAllModeAuthorMeta,
} = require("./all-mode-data");
const {
  createAllModePageRenderers,
} = require("./all-mode-render");
const {
  RAID_CHECK_ALL_COMPONENT_ACTION,
  getRaidCheckAllComponentRoute,
} = require("./all-mode-routes");

function buildRaidCheckRosterRefreshNoticePayload(result, lang) {
  const accountName = result?.accountName || "?";
  const target = result?.discordId ? `<@${result.discordId}>` : "?";
  if (result?.status === "updated") {
    return {
      type: "success",
      title: t("raid-check.refreshFlow.successTitle", lang),
      description: t("raid-check.refreshFlow.successDescription", lang, {
        accountName,
        target,
      }),
    };
  }
  if (result?.status === "attempted" || result?.status === "skipped") {
    return {
      type: "warn",
      title: t("raid-check.refreshFlow.noUpdateTitle", lang),
      description: t("raid-check.refreshFlow.noUpdateDescription", lang, {
        accountName,
        target,
      }),
    };
  }
  return {
    type: "warn",
    title: t("raid-check.refreshFlow.missingTitle", lang),
    description: t("raid-check.refreshFlow.missingDescription", lang, {
      accountName,
      target,
    }),
  };
}

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
  isManagerId,
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

    const { visibleUserIds, authorMeta } = resolveAllModeAuthorMeta({
      interaction,
      users,
      pagesData,
    });
    const totalPages = pagesData.length;
    const autoManageStateByDiscordId = new Map();
    const localSyncStateByDiscordId = new Map();
    for (const page of pagesData) {
      const id = page.userDoc?.discordId;
      if (!id || autoManageStateByDiscordId.has(id)) continue;
      autoManageStateByDiscordId.set(id, !!page.userDoc.autoManageEnabled);
      localSyncStateByDiscordId.set(id, !!page.userDoc.localSyncEnabled);
    }

    let filterUserId = null;
    let filterRaidId = null;
    let filterStatus = FILTER_STATUS.all;
    let currentView = "raid";
    let filteredIndices = pagesData.map((_, index) => index);
    let currentLocalPage = 0;
    let backgroundRefreshing = refreshQueued > 0;

    const currentAbsoluteIndex = () =>
      filteredIndices[currentLocalPage] ?? filteredIndices[0] ?? 0;
    const getRenderState = () => ({
      currentLocalPage,
      filterRaidId,
      filterStatus,
      filterUserId,
      filteredIndices,
      totalPages,
    });
    const pendingAggregateCache = createAllModePendingAggregateCache({
      pagesData,
      getStatusRaidsForCharacter,
      lang,
    });
    const { buildRaidPage, buildTaskPage } = createAllModePageRenderers({
      EmbedBuilder,
      UI,
      authorMeta,
      buildAccountPageEmbed,
      buildStatusFooterText,
      getState: getRenderState,
      getStatusRaidsForCharacter: pendingAggregateCache.getRaidsForCharacter,
      isManagerId,
      lang,
      pagesData,
      summarizeRaidProgress,
      truncateText,
    });
    const renderEmbed = (pageIndex) =>
      currentView === "task" ? buildTaskPage(pageIndex) : buildRaidPage(pageIndex);

    const applyRefreshedUserDoc = (userDoc) => {
      if (!userDoc?.discordId || !Array.isArray(userDoc.accounts)) return false;
      const userIndex = users.findIndex((user) => user.discordId === userDoc.discordId);
      if (userIndex >= 0) users[userIndex] = userDoc;
      for (const page of pagesData) {
        if (page.userDoc?.discordId !== userDoc.discordId) continue;
        page.userDoc = userDoc;
        const freshAccount = userDoc.accounts[page.accountIdx];
        if (freshAccount) page.account = freshAccount;
      }
      pendingAggregateCache.clear();
      return true;
    };

    const applyUserFilter = (pickedValue) => {
      filterUserId = pickedValue === FILTER_ALL ? null : pickedValue;
      if (filterUserId === null) {
        filteredIndices = pagesData.map((_, index) => index);
      } else {
        filteredIndices = [];
        for (let index = 0; index < pagesData.length; index += 1) {
          if (pagesData[index].userDoc.discordId === filterUserId) {
            filteredIndices.push(index);
          }
        }
      }
      currentLocalPage = 0;
    };

    const computePendingAggregate = ({ raidFilter, userFilter }) =>
      pendingAggregateCache.compute({ raidFilter, userFilter });

    const buildButtonRow = (disabled) => {
      const row = buildPaginationRow(currentLocalPage, filteredIndices.length, disabled, {
        prevId: "raid-check-all-page:prev",
        nextId: "raid-check-all-page:next",
        lang,
      });
      const currentAbs = currentAbsoluteIndex();
      const currentViewUserId = pagesData[currentAbs]?.userDoc?.discordId || "";
      const actionUserId = filterUserId || currentViewUserId;

      addAllModeActionButtons({
        row,
        ButtonBuilder,
        ButtonStyle,
        t,
        lang,
        disabled,
        currentView,
        currentViewUserId,
        actionUserId,
        autoManageStateByDiscordId,
        localSyncStateByDiscordId,
      });
      return row;
    };

    const buildRosterRefreshRow = (disabled) => {
      if (currentView !== "raid") return null;
      return buildAllModeRosterRefreshRow({
        ActionRowBuilder,
        ButtonBuilder,
        ButtonStyle,
        t,
        lang,
        disabled: disabled || backgroundRefreshing,
      });
    };

    const buildFilterRow = (disabled) =>
      buildAllModeUserFilterRow({
        ActionRowBuilder,
        StringSelectMenuBuilder,
        authorMeta,
        computePendingAggregate,
        disabled,
        filterRaidId,
        filterUserId,
        lang,
        t,
        truncateText,
        visibleUserIds,
      });

    const buildRaidFilterRow = (disabled) =>
      buildAllModeRaidFilterRow({
        ActionRowBuilder,
        StringSelectMenuBuilder,
        computePendingAggregate,
        disabled,
        filterRaidId,
        filterUserId,
        lang,
        t,
        truncateText,
      });

    const buildStatusFilterRow = (disabled) =>
      buildAllModeStatusFilterRow({
        ActionRowBuilder,
        StringSelectMenuBuilder,
        disabled,
        filterStatus,
        lang,
        t,
      });

    let teamsSnapshot = [];
    const buildComponents = (disabled) => {
      const rows = [buildButtonRow(disabled)];
      const refreshRow = buildRosterRefreshRow(disabled);
      if (refreshRow) rows.push(refreshRow);
      rows.push(buildFilterRow(disabled));
      if (currentView === "raid") {
        rows.push(buildRaidFilterRow(disabled));
        rows.push(buildStatusFilterRow(disabled));
      }
      rows.push(
        ...teamsView.buildTeamsRows({
          shapedEvents: teamsSnapshot,
          maxRows: 5 - rows.length,
          disabled,
          lang,
        })
      );
      return rows;
    };

    let sessionEnded = false;
    let backgroundRenderChain = Promise.resolve();
    const queueBackgroundRender = (label) => {
      backgroundRenderChain = backgroundRenderChain
        .then(async () => {
          if (sessionEnded) return;
          await interaction.editReply({
            embeds: [renderEmbed(currentAbsoluteIndex())],
            components: buildComponents(false),
          });
        })
        .catch((err) => {
          console.warn(`[raid-check all] ${label} background render failed:`, err?.message || err);
        });
      return backgroundRenderChain;
    };

    const followup = await interaction.editReply({
      embeds: [renderEmbed(currentAbsoluteIndex())],
      components: buildComponents(false),
    });
    console.log(
      `[raid-check all] rendered pages=${totalPages} users=${visibleUserIds.length} openMs=${Date.now() - started}`
    );

    const updateAllModeMessage = (component) =>
      component
        .update({
          embeds: [renderEmbed(currentAbsoluteIndex())],
          components: buildComponents(false),
        })
        .catch(() => {});
    const allModeComponentHandlers = {
      [RAID_CHECK_ALL_COMPONENT_ACTION.userFilter]: async (component) => {
        applyUserFilter(firstSelectValue(component, FILTER_ALL));
        await updateAllModeMessage(component);
      },
      [RAID_CHECK_ALL_COMPONENT_ACTION.raidFilter]: async (component) => {
        const value = firstSelectValue(component, FILTER_ALL_RAIDS);
        filterRaidId = value === FILTER_ALL_RAIDS ? null : value;
        await updateAllModeMessage(component);
      },
      [RAID_CHECK_ALL_COMPONENT_ACTION.statusFilter]: async (component) => {
        filterStatus = normalizeAllModeStatusFilter(
          firstSelectValue(component, FILTER_STATUS.all)
        );
        await updateAllModeMessage(component);
      },
      [RAID_CHECK_ALL_COMPONENT_ACTION.viewToggle]: async (component, route) => {
        currentView = route.targetView === "task" ? "task" : "raid";
        await updateAllModeMessage(component);
      },
      [RAID_CHECK_ALL_COMPONENT_ACTION.page]: async (component, route) => {
        const localTotal = filteredIndices.length;
        if (route.pageAction === "prev") {
          currentLocalPage = Math.max(0, currentLocalPage - 1);
        } else if (route.pageAction === "next") {
          currentLocalPage = Math.min(localTotal - 1, currentLocalPage + 1);
        } else {
          return;
        }
        await updateAllModeMessage(component);
      },
      [RAID_CHECK_ALL_COMPONENT_ACTION.rosterRefresh]: async (component) => {
        const page = pagesData[currentAbsoluteIndex()];
        const targetDiscordId = page?.userDoc?.discordId || "";
        const targetAccountName = page?.account?.accountName || "";
        if (!targetDiscordId || !targetAccountName) {
          await replyNotice(component, EmbedBuilder, {
            type: "warn",
            title: t("raid-check.refreshFlow.missingTitle", lang),
            description: t("raid-check.refreshFlow.missingDescription", lang, {
              accountName: targetAccountName || "?",
              target: targetDiscordId ? `<@${targetDiscordId}>` : "?",
            }),
          }).catch(() => {});
          return;
        }
        if (typeof runManualRosterRefresh !== "function") {
          await replyNotice(component, EmbedBuilder, {
            type: "error",
            title: t("raid-check.refreshFlow.failedTitle", lang),
            description: t("raid-check.refreshFlow.failedDescription", lang, {
              error: "manual refresh service unavailable",
            }),
          }).catch(() => {});
          return;
        }

        const deferred = await component.deferUpdate().then(() => true).catch((err) => {
          console.warn("[raid-check all] roster-refresh defer failed:", err?.message || err);
          return false;
        });
        if (!deferred) return;

        try {
          const result = await runManualRosterRefresh(targetDiscordId, targetAccountName);
          applyRefreshedUserDoc(result.userDoc);
          await interaction.editReply({
            embeds: [renderEmbed(currentAbsoluteIndex())],
            components: buildComponents(false),
          }).catch((err) => {
            console.warn("[raid-check all] roster-refresh editReply failed:", err?.message || err);
          });
          await followUpNotice(
            component,
            EmbedBuilder,
            buildRaidCheckRosterRefreshNoticePayload(
              { ...result, discordId: targetDiscordId },
              lang
            )
          ).catch(() => {});
        } catch (err) {
          console.error("[raid-check all] roster-refresh failed:", err?.message || err);
          await followUpNotice(component, EmbedBuilder, {
            type: "error",
            title: t("raid-check.refreshFlow.failedTitle", lang),
            description: t("raid-check.refreshFlow.failedDescription", lang, {
              error: err?.message || String(err),
            }),
          }).catch(() => {});
        }
      },
      [RAID_CHECK_ALL_COMPONENT_ACTION.teamsSelect]: async (component) => {
        const eventId = firstSelectValue(component);
        await teamsView.handleRaidCheckTeamsSelect(component, eventId, lang);
      },
    };

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
      sessionEnded = true;
      await backgroundRenderChain;
      await followup
        .edit({ components: buildComponents(true) })
        .catch(() => {});
    });

    if (typeof startBackgroundRefresh === "function" && refreshQueued > 0) {
      const refreshStarted = Date.now();
      void startBackgroundRefresh()
        .then((refreshedUsers) => {
          let applied = 0;
          for (const userDoc of refreshedUsers || []) {
            if (applyRefreshedUserDoc(userDoc)) applied += 1;
          }
          backgroundRefreshing = false;
          console.log(
            `[raid-check all] background refresh applied=${applied}/${refreshQueued} ms=${Date.now() - refreshStarted}`
          );
          return queueBackgroundRender("roster-refresh");
        })
        .catch((err) => {
          backgroundRefreshing = false;
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
        teamsSnapshot = Array.isArray(rows) ? rows : [];
        console.log(
          `[raid-check all] background teams=${teamsSnapshot.length} ms=${Date.now() - teamsStarted}`
        );
        if (teamsSnapshot.length > 0) return queueBackgroundRender("teams");
        return null;
      })
      .catch((err) => {
        console.warn("[raid-check all] background teams failed:", err?.message || err);
      });
  }

  return { handleRaidCheckAllCommand };
}

module.exports = { createAllModeHandler };
