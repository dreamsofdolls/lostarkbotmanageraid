"use strict";

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
  // (and by the /raid-sync entry point) so both synchronous render paths
  // can read it. null means "not fetched yet", which the renderer treats
  // as a fallback to the raid view rather than an error.
  let localSyncSnapshot = null;
  // Which roster page of the preview is showing. Lives beside the
  // snapshot rather than inside it so a refresh can replace the data
  // without losing the user's place.
  let localSyncRosterIndex = 0;
  let raidDropdownEntries = [];
  let rosterFilterEntries = [];
  let visibleRosterIndices = [];
  let totalRaidPending = 0;
  const taskCharFilterByPage = new Map();
  const goldCharFilterByPage = new Map();
  const raidGetter = createRaidGetter({ getStatusRaidsForCharacter });
  let totalCharacters = countCharacters(accounts);

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
    const reloadedOwnDoc = nextOwnDoc || await User.findOne({ discordId });
    if (reloadedOwnDoc && Array.isArray(reloadedOwnDoc.accounts)) {
      userDoc = reloadedOwnDoc;
    } else if (!userDoc || !Array.isArray(userDoc.accounts)) {
      userDoc = { discordId, accounts: [] };
    }

    accounts = await buildMergedAccounts(discordId, userDoc.accounts);
    totalCharacters = countCharacters(accounts);
    raidGetter.clear();
    recomputeDerivedState();
    return userDoc;
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
    get localSyncRosterIndex() {
      return localSyncRosterIndex;
    },
    set localSyncRosterIndex(value) {
      localSyncRosterIndex = Math.max(0, Number(value) || 0);
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
    get userDoc() {
      return userDoc;
    },
    getTaskCharFilter(page) {
      return taskCharFilterByPage.get(page);
    },
    getGoldCharFilter(page) {
      return goldCharFilterByPage.get(page);
    },
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
    get localSyncRosterIndex() {
      return state.localSyncRosterIndex;
    },
    set localSyncRosterIndex(value) {
      state.localSyncRosterIndex = value;
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
  countCharacters,
  createRaidStatusComponentSession,
  createRaidStatusSessionState,
};
