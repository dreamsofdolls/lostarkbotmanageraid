"use strict";

const RAID_STATUS_INTERACTIVE_REFRESH_MAX_AGE_MS = 5000;

function createRaidGetter({ getStatusRaidsForCharacter }) {
  const raidsCache = new Map();
  const getRaidsFor = (character) => {
    let result = raidsCache.get(character);
    if (!result) {
      result = getStatusRaidsForCharacter(character);
      raidsCache.set(character, result);
    }
    return result;
  };
  return { getRaidsFor, clear: () => raidsCache.clear() };
}

function countCharacters(accounts) {
  return accounts.reduce(
    (sum, account) => sum + (Array.isArray(account.characters) ? account.characters.length : 0),
    0
  );
}

async function createRaidStatusSessionState({
  User,
  discordId,
  userDoc: initialUserDoc,
  incomingSharedAccounts,
  buildMergedAccounts,
  getStatusRaidsForCharacter,
  buildRaidDropdownState,
  buildStatusRosterFilterEntries,
  initialView = "raid",
  now = Date.now,
  interactiveRefreshMaxAgeMs = RAID_STATUS_INTERACTIVE_REFRESH_MAX_AGE_MS,
}) {
  let userDoc = initialUserDoc;
  let accounts = await buildMergedAccounts(discordId, userDoc.accounts, {
    accessibleAccounts: incomingSharedAccounts,
  });
  let currentPage = 0;
  let selectedRosterIndex = null;
  let filterRaidId = null;
  let currentView = initialView;
  // Sync view payload · loaded asynchronously by the component handler
  // (and by Local Sync handoffs) so both synchronous render paths
  // can read it. null means "not fetched yet", which the renderer treats
  // as a fallback to the raid view rather than an error.
  let localSyncSnapshot = null;
  // Which roster of the preview the card is narrowed to. Lives beside the
  // snapshot rather than inside it so a refresh can replace the data
  // without losing the choice. null shows every roster the preview
  // touches, which is the default.
  let localSyncRosterFilter = null;
  let raidDropdownEntries = [];
  let rosterFilterEntries = [];
  let visibleRosterIndices = [];
  let totalRaidPending = 0;
  let totalSoloPending = 0;
  const taskCharFilterByPage = new Map();
  const goldCharFilterByPage = new Map();
  const raidGetter = createRaidGetter({ getStatusRaidsForCharacter });
  let totalCharacters = countCharacters(accounts);
  let lastReloadedAtMs = Number(now());
  let interactiveReloadPromise = null;

  const recomputeRosterNavigation = () => {
    rosterFilterEntries = buildStatusRosterFilterEntries({
      accounts,
      raidFilter: currentView === "raid" ? filterRaidId : null,
      getRaidsFor: raidGetter.getRaidsFor,
    });
    visibleRosterIndices = rosterFilterEntries.map((entry) => entry.pageIndex);

    if (visibleRosterIndices.length === 0) {
      currentPage = 0;
      selectedRosterIndex = null;
      return;
    }
    if (!visibleRosterIndices.includes(currentPage)) {
      currentPage = visibleRosterIndices[0];
    }
    if (
      Number.isInteger(selectedRosterIndex) &&
      !visibleRosterIndices.includes(selectedRosterIndex)
    ) {
      selectedRosterIndex = null;
    }
  };

  const recomputeRaidAggregate = () => {
    const nextState = buildRaidDropdownState(accounts, raidGetter.getRaidsFor);
    raidDropdownEntries = nextState.raidDropdownEntries;
    totalRaidPending = nextState.totalRaidPending;
    totalSoloPending = Number(nextState.totalSoloPending) || 0;
    if (filterRaidId && !raidDropdownEntries.some((entry) => entry.key === filterRaidId)) {
      filterRaidId = null;
    }
  };
  const recomputeDerivedState = () => {
    recomputeRaidAggregate();
    recomputeRosterNavigation();
  };
  recomputeDerivedState();

  async function reloadViewerAccounts(nextOwnDoc = null) {
    // Fresh share authorization and the own roster are independent reads. Keep
    // both fresh on reload, while overlapping their Mongo round trips.
    const [reloadedOwnDoc, sharedAccounts] = await Promise.all([
      nextOwnDoc || User.findOne({ discordId }),
      buildMergedAccounts(discordId, []),
    ]);
    if (reloadedOwnDoc && Array.isArray(reloadedOwnDoc.accounts)) {
      userDoc = reloadedOwnDoc;
    } else if (!userDoc || !Array.isArray(userDoc.accounts)) {
      userDoc = { discordId, accounts: [] };
    }

    accounts = [...userDoc.accounts, ...sharedAccounts];
    totalCharacters = countCharacters(accounts);
    raidGetter.clear();
    recomputeDerivedState();
    lastReloadedAtMs = Number(now());
    return userDoc;
  }

  function refreshViewerAccountsIfStale({ maxAgeMs = interactiveRefreshMaxAgeMs } = {}) {
    const normalizedMaxAgeMs = Math.max(0, Number(maxAgeMs) || 0);
    const ageMs = Math.max(0, Number(now()) - lastReloadedAtMs);
    if (ageMs < normalizedMaxAgeMs) return Promise.resolve(false);
    if (interactiveReloadPromise) return interactiveReloadPromise;

    interactiveReloadPromise = reloadViewerAccounts()
      .then(() => true)
      .finally(() => {
        interactiveReloadPromise = null;
      });
    return interactiveReloadPromise;
  }

  function movePage(delta) {
    if (visibleRosterIndices.length === 0) return;
    const currentLocalPage = Math.max(0, visibleRosterIndices.indexOf(currentPage));
    const nextLocalPage = Math.max(
      0,
      Math.min(
        visibleRosterIndices.length - 1,
        currentLocalPage + Number(delta || 0)
      )
    );
    currentPage = visibleRosterIndices[nextLocalPage];
    selectedRosterIndex = currentPage;
  }

  function selectRoster(rosterIndex) {
    if (rosterIndex === null) {
      selectedRosterIndex = null;
      currentPage = visibleRosterIndices[0] ?? 0;
      return;
    }
    if (!Number.isInteger(rosterIndex) || !visibleRosterIndices.includes(rosterIndex)) {
      return;
    }
    selectedRosterIndex = rosterIndex;
    currentPage = rosterIndex;
  }

  return {
    get accounts() {
      return accounts;
    },
    get baseGetRaidsFor() {
      return raidGetter.getRaidsFor;
    },
    get currentPage() {
      return currentPage;
    },
    set currentPage(value) {
      currentPage = value;
    },
    get currentLocalPage() {
      const localPage = visibleRosterIndices.indexOf(currentPage);
      return localPage >= 0 ? localPage : 0;
    },
    get selectedRosterIndex() {
      return selectedRosterIndex;
    },
    get visibleRosterCount() {
      return visibleRosterIndices.length;
    },
    get visibleRosterIndices() {
      return visibleRosterIndices;
    },
    get rosterFilterEntries() {
      return rosterFilterEntries;
    },
    get currentView() {
      return currentView;
    },
    set currentView(value) {
      currentView = value;
      recomputeRosterNavigation();
    },
    get localSyncSnapshot() {
      return localSyncSnapshot;
    },
    set localSyncSnapshot(value) {
      localSyncSnapshot = value;
    },
    get localSyncRosterFilter() {
      return localSyncRosterFilter;
    },
    set localSyncRosterFilter(value) {
      // null is Local Sync's aggregate "Rosters" state. The main raid-status
      // dropdown instead follows the roster shown on the current page.
      localSyncRosterFilter = value === null ? null : Math.max(0, Number(value) || 0);
    },
    get filterRaidId() {
      return filterRaidId;
    },
    set filterRaidId(value) {
      filterRaidId = value;
      recomputeRosterNavigation();
    },
    get raidDropdownEntries() {
      return raidDropdownEntries;
    },
    get totalCharacters() {
      return totalCharacters;
    },
    get totalRaidPending() {
      return totalRaidPending;
    },
    get totalSoloPending() {
      return totalSoloPending;
    },
    get userDoc() {
      return userDoc;
    },
    getTaskCharFilter(page) {
      return taskCharFilterByPage.get(page);
    },
    getGoldCharFilter(page) {
      return goldCharFilterByPage.get(page);
    },
    refreshViewerAccountsIfStale,
    reloadViewerAccounts,
    movePage,
    selectRoster,
    setGoldCharFilterForPage(page, value) {
      goldCharFilterByPage.set(page, value);
    },
    setTaskCharFilterForPage(page, value) {
      taskCharFilterByPage.set(page, value);
    },
  };
}

function createRaidStatusComponentSession({
  state,
  getStatusUserMeta,
  setStatusUserMeta,
  syncControls,
}) {
  return {
    get accounts() {
      return state.accounts;
    },
    get currentPage() {
      return state.currentPage;
    },
    set currentPage(value) {
      state.currentPage = value;
    },
    get selectedRosterIndex() {
      return state.selectedRosterIndex;
    },
    movePage(delta) {
      state.movePage(delta);
    },
    selectRoster(rosterIndex) {
      state.selectRoster(rosterIndex);
    },
    set filterRaidId(value) {
      state.filterRaidId = value;
    },
    set currentView(value) {
      state.currentView = value;
    },
    get currentView() {
      return state.currentView;
    },
    get localSyncSnapshot() {
      return state.localSyncSnapshot;
    },
    set localSyncSnapshot(value) {
      state.localSyncSnapshot = value;
    },
    get localSyncRosterFilter() {
      return state.localSyncRosterFilter;
    },
    set localSyncRosterFilter(value) {
      state.localSyncRosterFilter = value;
    },
    get statusUserMeta() {
      return getStatusUserMeta();
    },
    set statusUserMeta(value) {
      setStatusUserMeta(value);
    },
    get userDoc() {
      return state.userDoc;
    },
    setCachedLocalSyncResumeUrl(value) {
      syncControls.setCachedLocalSyncResumeUrl(value);
    },
    setTaskCharFilterForPage(page, value) {
      state.setTaskCharFilterForPage(page, value);
    },
    setGoldCharFilterForPage(page, value) {
      state.setGoldCharFilterForPage(page, value);
    },
  };
}

module.exports = {
  createRaidStatusComponentSession,
  createRaidStatusSessionState,
};
