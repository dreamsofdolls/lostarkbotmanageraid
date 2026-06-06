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
  buildSyncButton,
  buildSyncRow,
  buildLocalSyncNewButton,
  buildLocalSyncRefreshButton,
  buildRaidFilterRow,
  buildMyRaidsRow,
  getAccounts,
  getCurrentPage,
  getCurrentView,
  getStatusUserMeta,
  getRaidDropdownEntries,
  getTotalRaidPending,
  getFilterRaidId,
  getMyRaidsShaped,
}) {
  const addTaskViewRows = (rows, disabled) => {
    const accounts = getAccounts();
    const currentPage = getCurrentPage();
    if (accounts.length > 1) {
      rows.push(
        buildPaginationRow(currentPage, accounts.length, disabled, {
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

  const addRaidViewNavigationRows = (rows, disabled, showSync) => {
    const accounts = getAccounts();
    const currentPage = getCurrentPage();
    const statusUserMeta = getStatusUserMeta();

    if (accounts.length > 1) {
      const paginationRow = buildPaginationRow(currentPage, accounts.length, disabled, {
        prevId: "status:prev",
        nextId: "status:next",
        lang,
      });
      if (showSync) {
        const btn = buildSyncButton(disabled);
        if (btn) paginationRow.addComponents(btn);
        if (statusUserMeta.localSyncEnabled) {
          const newBtn = buildLocalSyncNewButton(disabled);
          if (newBtn) {
            paginationRow.addComponents(newBtn);
            paginationRow.addComponents(buildLocalSyncRefreshButton(disabled));
          }
        }
      }
      rows.push(paginationRow);
      return;
    }

    if (showSync) {
      const row = buildSyncRow(disabled);
      if (row) rows.push(row);
    }
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

    const currentAccount = accounts[currentPage];
    const currentPageIsShared = !!currentAccount?._sharedFrom;
    const statusUserMeta = getStatusUserMeta();
    const anySyncMode = statusUserMeta.autoManageEnabled || statusUserMeta.localSyncEnabled;
    const showSync = anySyncMode && !currentPageIsShared;

    addRaidViewNavigationRows(rows, disabled, showSync);
    rows.push(buildViewToggleRow(disabled));
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
