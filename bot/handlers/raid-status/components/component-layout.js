"use strict";

function createRaidStatusComponentLayout({
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
  buildSyncButton,
  buildSyncRow,
  buildLocalSyncNewButton,
  buildLocalSyncRefreshButton,
  buildRosterRefreshButton,
  buildSoloCompanionButton,
  buildRaidFilterRow,
  buildStatusRosterFilterRow,
  buildMyRaidsRow,
  getAccounts,
  getCurrentPage,
  getCurrentLocalPage = getCurrentPage,
  getVisibleRosterCount = () => getAccounts().length,
  getCurrentView,
  getStatusUserMeta,
  getRaidDropdownEntries,
  getTotalRaidPending,
  getFilterRaidId,
  getRosterFilterEntries = () => [],
  getSelectedRosterIndex = () => null,
  getMyRaidsShaped,
  getBackgroundRefreshing = () => false,
}) {
  const getRowComponentCount = (row) => {
    if (Array.isArray(row?.components)) return row.components.length;
    if (Array.isArray(row?.data?.components)) return row.data.components.length;
    return 0;
  };

  const addButtonToBestRow = (rows, button) => {
    if (!button) return;
    const lastRow = rows[rows.length - 1];
    if (lastRow && getRowComponentCount(lastRow) < 5) {
      lastRow.addComponents(button);
      return;
    }
    if (rows.length >= 5) return;
    rows.push(new ActionRowBuilder().addComponents(button));
  };

  const addTaskViewRows = (rows, disabled) => {
    const visibleRosterCount = getVisibleRosterCount();
    if (visibleRosterCount > 1) {
      rows.push(
        buildPaginationRow(getCurrentLocalPage(), visibleRosterCount, disabled, {
          prevId: "status:prev",
          nextId: "status:next",
          lang,
        })
      );
    }

    rows.push(buildViewToggleRow(disabled));
    const sharedTaskRow = buildSharedTaskToggleRow(disabled);
    if (sharedTaskRow) rows.push(sharedTaskRow);
    const charFilterRow = buildTaskCharFilterRow(disabled);
    if (charFilterRow) rows.push(charFilterRow);
    rows.push(buildTaskToggleRow(disabled));
  };

  const addGoldViewRows = (rows, disabled) => {
    const accounts = getAccounts();
    const currentPage = getCurrentPage();
    const visibleRosterCount = getVisibleRosterCount();
    if (visibleRosterCount > 1) {
      rows.push(
        buildPaginationRow(getCurrentLocalPage(), visibleRosterCount, disabled, {
          prevId: "status:prev",
          nextId: "status:next",
          lang,
        })
      );
    }

    rows.push(buildViewToggleRow(disabled));
    const charFilterRow = buildGoldCharFilterRow(disabled);
    if (charFilterRow) rows.push(charFilterRow);

    const currentAccount = accounts[currentPage];
    const sharedFrom = currentAccount?._sharedFrom;
    const goldToggleDisabled = disabled || (!!sharedFrom && sharedFrom.accessLevel !== "edit");
    rows.push(buildGoldToggleRow(goldToggleDisabled));
    const modeRow = typeof buildGoldModeRow === "function"
      ? buildGoldModeRow(goldToggleDisabled)
      : null;
    if (modeRow && rows.length < 5) rows.push(modeRow);
  };

  const addRaidViewNavigationRows = (rows, disabled, showSync, syncDisabled) => {
    const visibleRosterCount = getVisibleRosterCount();
    const statusUserMeta = getStatusUserMeta();
    const appendSoloCompanionButton = (row) => {
      if (typeof buildSoloCompanionButton !== "function") return;
      const button = buildSoloCompanionButton(syncDisabled);
      if (button && getRowComponentCount(row) < 5) row.addComponents(button);
    };

    if (visibleRosterCount > 1) {
      const paginationRow = buildPaginationRow(
        getCurrentLocalPage(),
        visibleRosterCount,
        disabled,
        {
          prevId: "status:prev",
          nextId: "status:next",
          lang,
        }
      );
      if (showSync) {
        const btn = buildSyncButton(syncDisabled);
        if (btn) paginationRow.addComponents(btn);
        if (statusUserMeta.localSyncEnabled) {
          const newBtn = buildLocalSyncNewButton(syncDisabled);
          if (newBtn) {
            paginationRow.addComponents(newBtn);
            paginationRow.addComponents(buildLocalSyncRefreshButton(syncDisabled));
          }
        } else {
          appendSoloCompanionButton(paginationRow);
        }
      }
      rows.push(paginationRow);
      return;
    }

    if (showSync) {
      const row = buildSyncRow(syncDisabled);
      if (row) {
        if (!statusUserMeta.localSyncEnabled) appendSoloCompanionButton(row);
        rows.push(row);
      }
    }
  };

  const addRosterRefreshRow = (rows, disabled, showRosterRefresh) => {
    if (!showRosterRefresh) return;
    addButtonToBestRow(rows, buildRosterRefreshButton(disabled));
  };

  const addRaidFilterRow = (rows, disabled) => {
    const raidDropdownEntries = getRaidDropdownEntries();
    if (raidDropdownEntries.length === 0) return;
    rows.push(buildRaidFilterRow({
      ActionRowBuilder,
      StringSelectMenuBuilder,
      truncateText,
      raidDropdownEntries,
      totalRaidPending: getTotalRaidPending(),
      filterRaidId: getFilterRaidId(),
      disabled,
      lang,
    }));
  };

  const addRosterFilterRow = (rows, disabled) => {
    if (getAccounts().length <= 1 || rows.length >= 5) return;
    rows.push(buildStatusRosterFilterRow({
      ActionRowBuilder,
      StringSelectMenuBuilder,
      truncateText,
      rosterFilterEntries: getRosterFilterEntries(),
      selectedRosterIndex: getSelectedRosterIndex(),
      disabled,
      lang,
    }));
  };

  const addMyRaidsRow = (rows, disabled) => {
    const shapedEvents = getMyRaidsShaped();
    if (shapedEvents.length === 0 || rows.length >= 5) return;
    rows.push(buildMyRaidsRow({
      ActionRowBuilder,
      StringSelectMenuBuilder,
      truncateText,
      shapedEvents,
      disabled,
      lang,
    }));
  };

  const buildComponents = (disabled) => {
    const rows = [];
    const accounts = getAccounts();
    const currentPage = getCurrentPage();

    if (getCurrentView() === "task") {
      addTaskViewRows(rows, disabled);
      return rows;
    }
    if (getCurrentView() === "gold") {
      addGoldViewRows(rows, disabled);
      return rows;
    }

    const currentAccount = accounts[currentPage];
    const sharedFrom = currentAccount?._sharedFrom;
    const currentPageIsShared = !!sharedFrom;
    const showRosterRefresh =
      !!currentAccount?.accountName &&
      (!sharedFrom || sharedFrom.accessLevel === "edit");
    const statusUserMeta = getStatusUserMeta();
    const anySyncMode = statusUserMeta.autoManageEnabled || statusUserMeta.localSyncEnabled;
    const showSync = anySyncMode && !currentPageIsShared;
    const refreshDisabled = disabled || getBackgroundRefreshing();

    addRaidViewNavigationRows(rows, disabled, showSync, refreshDisabled);
    addRosterRefreshRow(rows, refreshDisabled, showRosterRefresh);
    rows.push(buildViewToggleRow(disabled));
    addRosterFilterRow(rows, disabled);
    addRaidFilterRow(rows, disabled);
    addMyRaidsRow(rows, disabled);
    return rows;
  };

  return {
    buildComponents,
  };
}

module.exports = {
  createRaidStatusComponentLayout,
};
