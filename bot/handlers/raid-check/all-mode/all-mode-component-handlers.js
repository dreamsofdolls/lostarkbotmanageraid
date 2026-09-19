"use strict";

/**
 * Collector handlers for one /raid-check all-mode session: selector updates,
 * pagination, manual roster refresh and the teams select. All handlers mutate
 * the shared mutable `state` and re-render through the supplied builders.
 */

const {
  followUpNotice,
  replyNotice,
} = require("../../../utils/raid/common/shared");
const { firstSelectValue } = require("../../../utils/discord/component-values");
// tPick, not t: the refresh titles are variant pools; other keys pass through.
const { tPick: t } = require("../../../services/i18n");
const {
  FILTER_ALL,
  FILTER_ALL_RAIDS,
  FILTER_ALL_ROSTERS,
  FILTER_STATUS,
  getAllModeRosterSelectionForPage,
  normalizeAllModeStatusFilter,
} = require("./all-mode-filters");
const {
  RAID_CHECK_ALL_COMPONENT_ACTION,
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

/**
 * Create the per-customId handler map for the all-mode collector.
 *
 * @param {object} deps Session wiring: builders, caches and the shared
 *   mutable `state` the handlers mutate.
 * @param {object} deps.state Mutable session state (filters, page).
 * @param {(component: object) => Promise<void>} deps.applyUserFilter Applies
 *   the user selector value and recomputes filtered pages.
 * @param {(options?: { resetPage?: boolean }) => void} deps.recomputeFilteredPages
 *   Recomputes the filtered page list from current state.
 * @param {() => number | null} deps.currentAbsoluteIndex Resolves the page
 *   index currently shown to the user.
 * @param {(pageIndex: number | null) => object} deps.renderEmbed Renders the
 *   embed for a page index (or the no-filter-matches notice).
 * @param {(disabled: boolean) => Array<object>} deps.buildComponents Builds
 *   the component rows for a render.
 * @returns {Record<string, (component: object, route?: object) => Promise<void>>}
 *   Handlers keyed by RAID_CHECK_ALL_COMPONENT_ACTION.
 */
function createAllModeComponentHandlers({
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
}) {
  const updateAllModeMessage = (component) =>
    component
      .update({
        embeds: [renderEmbed(currentAbsoluteIndex())],
        components: buildComponents(false),
      })
      .catch(() => {});
  return {
    [RAID_CHECK_ALL_COMPONENT_ACTION.userFilter]: async (component) => {
      applyUserFilter(firstSelectValue(component, FILTER_ALL));
      await updateAllModeMessage(component);
    },
    [RAID_CHECK_ALL_COMPONENT_ACTION.rosterFilter]: async (component) => {
      const value = firstSelectValue(component, FILTER_ALL_ROSTERS);
      if (value === FILTER_ALL_ROSTERS) {
        state.filterRosterIndex = null;
      } else {
        const parsed = Number.parseInt(value, 10);
        state.filterRosterIndex = Number.isInteger(parsed) ? parsed : null;
      }
      recomputeFilteredPages();
      await updateAllModeMessage(component);
    },
    [RAID_CHECK_ALL_COMPONENT_ACTION.raidFilter]: async (component) => {
      const value = firstSelectValue(component, FILTER_ALL_RAIDS);
      state.filterRaidId = value === FILTER_ALL_RAIDS ? null : value;
      recomputeFilteredPages();
      await updateAllModeMessage(component);
    },
    [RAID_CHECK_ALL_COMPONENT_ACTION.statusFilter]: async (component) => {
      state.filterStatus = normalizeAllModeStatusFilter(
        firstSelectValue(component, FILTER_STATUS.all)
      );
      recomputeFilteredPages();
      await updateAllModeMessage(component);
    },
    [RAID_CHECK_ALL_COMPONENT_ACTION.page]: async (component, route) => {
      const localTotal = state.filteredIndices.length;
      if (localTotal === 0) return;
      if (route.pageAction === "prev") {
        state.currentLocalPage = Math.max(0, state.currentLocalPage - 1);
      } else if (route.pageAction === "next") {
        state.currentLocalPage = Math.min(localTotal - 1, state.currentLocalPage + 1);
      } else {
        return;
      }
      state.filterRosterIndex = getAllModeRosterSelectionForPage({
        filterUserId: state.filterUserId,
        filteredIndices: state.filteredIndices,
        currentLocalPage: state.currentLocalPage,
      });
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
        if (applyRefreshedUserDoc(result.userDoc)) pendingAggregateCache.clear();
        recomputeFilteredPages({ resetPage: false });
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
}

module.exports = { createAllModeComponentHandlers };
