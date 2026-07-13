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
}) {
  let userDoc = initialUserDoc;
  let accounts = await buildMergedAccounts(discordId, userDoc.accounts, {
    accessibleAccounts: incomingSharedAccounts,
  });
  let currentPage = 0;
  let filterRaidId = null;
  let currentView = "raid";
  let raidDropdownEntries = [];
  let totalRaidPending = 0;
  const taskCharFilterByPage = new Map();
  const goldCharFilterByPage = new Map();
  const raidGetter = createRaidGetter({ getStatusRaidsForCharacter });
  let totalCharacters = countCharacters(accounts);

  const recomputeRaidAggregate = () => {
    const nextState = buildRaidDropdownState(accounts, raidGetter.getRaidsFor);
    raidDropdownEntries = nextState.raidDropdownEntries;
    totalRaidPending = nextState.totalRaidPending;
    if (filterRaidId && !raidDropdownEntries.some((entry) => entry.key === filterRaidId)) {
      filterRaidId = null;
    }
  };
  recomputeRaidAggregate();

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
    recomputeRaidAggregate();
    if (currentPage >= accounts.length) {
      currentPage = Math.max(0, accounts.length - 1);
    }
    return userDoc;
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
    get currentView() {
      return currentView;
    },
    set currentView(value) {
      currentView = value;
    },
    get filterRaidId() {
      return filterRaidId;
    },
    set filterRaidId(value) {
      filterRaidId = value;
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
    set filterRaidId(value) {
      state.filterRaidId = value;
    },
    set currentView(value) {
      state.currentView = value;
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
