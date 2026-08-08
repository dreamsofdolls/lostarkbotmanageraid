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
  buildLocalSyncViewRows = () => [],
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

  // Local Sync view: actions first, view switcher last. The card's whole
  // job is "do the next thing with this preview", so apply/cancel/refresh
  // and the reader links sit directly under the text that describes them;
  // the dropdown is navigation and belongs at the bottom, out of the way.
  // Pagination and filters are omitted on purpose · a preview is
  // account-wide, so per-roster navigation would suggest a scope the
  // buttons do not have.
  const addSyncViewRows = (rows, disabled) => {
    for (const row of buildLocalSyncViewRows(disabled)) {
      if (rows.length >= 4) break; // leave the last slot for the view dropdown
      rows.push(row);
    }
    // Solo Local Reader rides along as the second way in. It only builds
    // for bible auto-sync users (see buildSoloCompanionButton), so for
    // full local-sync users nothing is added here.
    if (typeof buildSoloCompanionButton === "function") {
      addButtonToBestRow(rows, buildSoloCompanionButton(disabled));
    }
    rows.push(buildViewToggleRow(disabled));
  };

  // Returns the "leaves Discord" row for local-sync users, or null.
  // Callers push it AFTER the roster-refresh button has had its chance at
  // the navigation row · see buildComponents.
  //
  // Local-sync mode groups the controls by where they take you: paging,
  // progress refresh and roster refresh act inside Discord and share the
  // navigation row, while Open Local Reader and New link send you out to
  // the browser and get a row of their own. Bible mode is untouched; it
  // has only one sync button plus the Solo reader, which fit on one row.
  const addRaidViewNavigationRows = (rows, disabled, showSync, syncDisabled) => {
    const visibleRosterCount = getVisibleRosterCount();
    const statusUserMeta = getStatusUserMeta();
    const localSync = showSync && statusUserMeta.localSyncEnabled;
    const appendSoloCompanionButton = (row) => {
      if (typeof buildSoloCompanionButton !== "function") return;
      const button = buildSoloCompanionButton(syncDisabled);
      if (button && getRowComponentCount(row) < 5) row.addComponents(button);
    };

    // Both builders return null when no public base URL is configured, in
    // which case there is no web row at all.
    const companionButtons = localSync
      ? [buildSyncButton(syncDisabled), buildLocalSyncNewButton(syncDisabled)].filter(Boolean)
      : [];
    const companionRow = companionButtons.length > 0
      ? new ActionRowBuilder().addComponents(...companionButtons)
      : null;

    const addInDiscordSyncButtons = (row) => {
      if (!showSync) return;
      if (localSync) {
        row.addComponents(buildLocalSyncRefreshButton(syncDisabled));
        return;
      }
      const btn = buildSyncButton(syncDisabled);
      if (btn) row.addComponents(btn);
      appendSoloCompanionButton(row);
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
      addInDiscordSyncButtons(paginationRow);
      rows.push(paginationRow);
      return companionRow;
    }

    if (localSync) {
      rows.push(new ActionRowBuilder().addComponents(buildLocalSyncRefreshButton(syncDisabled)));
      return companionRow;
    }
    if (showSync) {
      const row = buildSyncRow(syncDisabled);
      if (row) {
        appendSoloCompanionButton(row);
        rows.push(row);
      }
    }
    return null;
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
    if (getCurrentView() === "sync") {
      addSyncViewRows(rows, disabled);
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

    const companionRow = addRaidViewNavigationRows(rows, disabled, showSync, refreshDisabled);
    // Roster refresh goes first so it lands on the navigation row it
    // belongs to · pushing the web row before this would capture it.
    addRosterRefreshRow(rows, refreshDisabled, showRosterRefresh);
    if (companionRow && rows.length < 5) rows.push(companionRow);
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
