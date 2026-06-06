"use strict";

const { buildNoticeEmbed, replyNotice, UI } = require("../../../utils/raid/common/shared");
const { firstSelectValue } = require("../../../utils/discord/component-values");
const { t, getUserLanguage } = require("../../../services/i18n");
const { createTeamsViewUi } = require("../views/teams-view");
const { computeAllModePendingAggregate } = require("./all-mode-aggregate");
const { addAllModeActionButtons } = require("./all-mode-buttons");
const {
  FILTER_ALL,
  FILTER_ALL_RAIDS,
  buildAllModeRaidFilterRow,
  buildAllModeUserFilterRow,
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
  discordUserLimiter,
  raidCheckRefreshLimiter,
  loadFreshUserSnapshotForRaidViews,
  shouldLoadFreshUserSnapshotForRaidViews,
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
    MessageFlags,
    UI,
    RaidEvent,
    User,
    buildScheduleEmbed,
    buildTurnPlanEmbed,
    truncateText,
  });

  async function handleRaidCheckAllCommand(interaction) {
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    if (!isRaidLeader(interaction)) {
      await replyNotice(interaction, EmbedBuilder, {
        type: "lock",
        title: t("raid-check.auth.managerOnlyTitle", lang),
        description: t("raid-check.auth.managerOnlyDescription", lang),
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const started = Date.now();
    const {
      users,
      refreshQueued,
      freshBypass,
      canRefreshFreshData,
    } = await loadAllModeUsers({
      User,
      ensureFreshWeek,
      RAID_CHECK_USER_QUERY_FIELDS,
      raidCheckRefreshLimiter,
      loadFreshUserSnapshotForRaidViews,
      shouldLoadFreshUserSnapshotForRaidViews,
    });
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

    const { visibleUserIds, authorMeta } = await resolveAllModeAuthorMeta({
      interaction,
      users,
      pagesData,
      discordUserLimiter,
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
    let currentView = "raid";
    let filteredIndices = pagesData.map((_, index) => index);
    let currentLocalPage = 0;

    const currentAbsoluteIndex = () =>
      filteredIndices[currentLocalPage] ?? filteredIndices[0] ?? 0;
    const getRenderState = () => ({
      currentLocalPage,
      filterRaidId,
      filterUserId,
      filteredIndices,
      totalPages,
    });
    const { buildRaidPage, buildTaskPage } = createAllModePageRenderers({
      EmbedBuilder,
      UI,
      authorMeta,
      buildAccountPageEmbed,
      buildStatusFooterText,
      getState: getRenderState,
      getStatusRaidsForCharacter,
      isManagerId,
      lang,
      pagesData,
      summarizeRaidProgress,
      truncateText,
    });
    const renderEmbed = (pageIndex) =>
      currentView === "task" ? buildTaskPage(pageIndex) : buildRaidPage(pageIndex);

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
      computeAllModePendingAggregate({
        pagesData,
        raidFilter,
        userFilter,
        getStatusRaidsForCharacter,
        lang,
      });

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

    const teamsSnapshot = await teamsView.loadActiveEventsForTeams({
      guildId: interaction.guildId || interaction.guild?.id,
    });
    const buildComponents = (disabled) => {
      const rows = [buildButtonRow(disabled), buildFilterRow(disabled)];
      if (currentView === "raid") {
        rows.push(buildRaidFilterRow(disabled));
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

    await interaction.editReply({
      embeds: [renderEmbed(currentAbsoluteIndex())],
      components: buildComponents(false),
    });
    const followup = await interaction.fetchReply();
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
          const clickerLang = await getUserLanguage(component.user.id, { UserModel: User });
          await replyNotice(component, EmbedBuilder, {
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
      await followup
        .edit({ components: buildComponents(true) })
        .catch(() => {});
    });
  }

  return { handleRaidCheckAllCommand };
}

module.exports = { createAllModeHandler };
