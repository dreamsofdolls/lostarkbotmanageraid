"use strict";

/**
 * Component row builders for one /raid-check all-mode session. Row layout is
 * read fresh from the shared mutable `state` on every call so background
 * refreshes and collector updates reuse the same builders.
 */

const {
  FILTER_STATUS,
  buildAllModeRaidFilterRow,
  buildAllModeRosterFilterRow,
  buildAllModeStatusFilterRow,
  buildAllModeUserFilterRow,
} = require("./all-mode-filters");
const {
  addAllModeActionButtons,
  buildRosterRefreshButton,
  buildSyncAllButton,
} = require("./all-mode-buttons");

/**
 * Create the component-row builders for one all-mode session.
 *
 * @param {object} deps Discord builders, i18n helpers and session inputs.
 * @param {object} deps.state Mutable session state (filters, view, page,
 *   background flags, teams snapshot); read at call time, never cached.
 * @param {() => number | null} deps.currentAbsoluteIndex Resolves the page
 *   index currently shown to the user.
 * @returns {{ buildComponents: (disabled: boolean) => Array<object> }} Row
 *   builder used for every render of the session.
 */
function createAllModeViewBuilders({
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
  getRaidsForCharacter,
  buildPaginationRow,
  teamsView,
  state,
  currentAbsoluteIndex,
}) {
  const buildControlRows = (disabled) => {
    const {
      currentView,
      filterUserId,
      backgroundRefreshing,
      currentLocalPage,
      filteredIndices,
    } = state;
    const currentAbs = currentAbsoluteIndex();
    const hasCurrentPage = Number.isInteger(currentAbs);
    const navigationRow = hasCurrentPage
      ? buildPaginationRow(currentLocalPage, filteredIndices.length, disabled, {
          prevId: "raid-check-all-page:prev",
          nextId: "raid-check-all-page:next",
          lang,
        })
      : new ActionRowBuilder();
    const currentViewUserId = hasCurrentPage
      ? pagesData[currentAbs]?.userDoc?.discordId || ""
      : "";
    const actionUserId = filterUserId || currentViewUserId;
    // The overview has room for a dedicated action row: keep page navigation
    // and roster refresh together, then place Edit/Tasks beneath them. A
    // user-filtered raid view already uses four selector rows, so it retains
    // the compact single row to stay within Discord's five-row limit.
    const separateActionRow = currentView !== "raid" || filterUserId === null;
    const actionRow = separateActionRow
      ? new ActionRowBuilder()
      : navigationRow;

    addAllModeActionButtons({
      row: actionRow,
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
    // The unfiltered overview has a separate row; the user-filtered view
    // already fills Discord's five-row / five-button limits.
    if (separateActionRow && currentView === "raid") {
      actionRow.addComponents(buildSyncAllButton({
        ButtonBuilder, ButtonStyle, t, lang, disabled,
      }));
    }
    if (
      currentView === "raid" &&
      hasCurrentPage &&
      navigationRow.components.length < 5
    ) {
      navigationRow.addComponents(
        buildRosterRefreshButton({
          ButtonBuilder,
          ButtonStyle,
          t,
          lang,
          disabled: disabled || backgroundRefreshing,
        })
      );
    }
    const rows = [];
    if (navigationRow.components.length > 0) rows.push(navigationRow);
    if (
      separateActionRow &&
      actionRow.components.length > 0
    ) {
      rows.push(actionRow);
    }
    return rows;
  };

  const buildFilterRow = (disabled) => {
    const { filterRaidId, filterUserId } = state;
    return buildAllModeUserFilterRow({
      ActionRowBuilder,
      StringSelectMenuBuilder,
      authorMeta,
      computePendingAggregate,
      currentPageUserId:
        pagesData[currentAbsoluteIndex()]?.userDoc?.discordId || null,
      disabled,
      filterRaidId,
      filterUserId,
      lang,
      t,
      truncateText,
      visibleUserIds,
    });
  };

  const buildRosterFilterRow = (disabled) => {
    const {
      currentView,
      filterRaidId,
      filterStatus,
      filterUserId,
      filterRosterIndex,
    } = state;
    return buildAllModeRosterFilterRow({
      ActionRowBuilder,
      StringSelectMenuBuilder,
      disabled,
      filterRaidId: currentView === "raid" ? filterRaidId : null,
      filterRosterIndex,
      currentPageIndex: currentAbsoluteIndex(),
      filterStatus: currentView === "raid" ? filterStatus : FILTER_STATUS.all,
      filterUserId,
      getStatusRaidsForCharacter: getRaidsForCharacter,
      lang,
      pagesData,
      t,
      truncateText,
      applyRaidEligibility: currentView === "raid",
    });
  };

  const buildRaidFilterRow = (disabled) => {
    const { filterRaidId, filterUserId } = state;
    return buildAllModeRaidFilterRow({
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
  };

  const buildStatusFilterRow = (disabled) => {
    const { filterStatus } = state;
    return buildAllModeStatusFilterRow({
      ActionRowBuilder,
      StringSelectMenuBuilder,
      disabled,
      filterStatus,
      lang,
      t,
    });
  };

  const buildComponents = (disabled) => {
    const { currentView, filterUserId, teamsSnapshot } = state;
    const rows = buildControlRows(disabled);
    rows.push(buildFilterRow(disabled));
    if (filterUserId !== null) {
      rows.push(buildRosterFilterRow(disabled));
    }
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

  return { buildComponents };
}

module.exports = { createAllModeViewBuilders };
