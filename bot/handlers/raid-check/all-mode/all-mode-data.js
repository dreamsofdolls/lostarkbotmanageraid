"use strict";

const { toPlainUserDoc } = require("../../../utils/user-doc");
const { normalizeName } = require("../../../utils/raid/common/shared");

const AUTHOR_META_FETCH_CONCURRENCY = 4;

function cleanIdentityValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildDiscordAuthorMeta({ member = null, user = null, cachedDisplayName = "" } = {}) {
  const discordUser = member?.user || user || null;
  const memberDisplayName = cleanIdentityValue(member?.displayName || member?.nickname);
  const userDisplayName = cleanIdentityValue(
    discordUser?.globalName || discordUser?.displayName || discordUser?.username
  );
  const avatarSource =
    typeof member?.displayAvatarURL === "function" ? member : discordUser;
  let avatarURL = null;
  if (typeof avatarSource?.displayAvatarURL === "function") {
    avatarURL = avatarSource.displayAvatarURL({ size: 64 });
  }
  return {
    displayName:
      memberDisplayName || cleanIdentityValue(cachedDisplayName) || userDisplayName,
    avatarURL,
  };
}

async function fetchDiscordAuthorMeta(interaction, discordId) {
  let member = null;
  const members = interaction?.guild?.members;
  if (typeof members?.fetch === "function") {
    member = await members
      .fetch({ user: discordId, cache: true })
      .catch(() => null);
  }

  let user = member?.user || null;
  const users = interaction?.client?.users;
  if (!user && typeof users?.fetch === "function") {
    user = await users.fetch(discordId).catch(() => null);
  }
  return buildDiscordAuthorMeta({ member, user });
}

function cloneRenderUserDoc(userDoc) {
  const plain = toPlainUserDoc(userDoc);
  if (!plain || plain !== userDoc) return plain;
  if (typeof structuredClone === "function") return structuredClone(plain);
  return JSON.parse(JSON.stringify(plain));
}

function canRefreshAllModeUsers({
  raidCheckRefreshLimiter,
  loadFreshUserSnapshotForRaidViews,
}) {
  return Boolean(
    typeof loadFreshUserSnapshotForRaidViews === "function" &&
      raidCheckRefreshLimiter &&
      typeof raidCheckRefreshLimiter.run === "function"
  );
}

function createAllModeUsersQuery({ User, RAID_CHECK_USER_QUERY_FIELDS }) {
  return User.find({ "accounts.0": { $exists: true } }).select(
    RAID_CHECK_USER_QUERY_FIELDS
  );
}

async function loadAllModeUsers({
  User,
  ensureFreshWeek,
  RAID_CHECK_USER_QUERY_FIELDS,
  raidCheckRefreshLimiter,
  loadFreshUserSnapshotForRaidViews,
  shouldLoadFreshUserSnapshotForRaidViews,
}) {
  const canRefreshFreshData = canRefreshAllModeUsers({
    raidCheckRefreshLimiter,
    loadFreshUserSnapshotForRaidViews,
  });
  const query = createAllModeUsersQuery({ User, RAID_CHECK_USER_QUERY_FIELDS });

  if (!canRefreshFreshData) {
    const users = await query.lean();
    for (const userDoc of users) {
      ensureFreshWeek(userDoc);
    }
    return {
      users,
      refreshQueued: 0,
      freshBypass: 0,
      canRefreshFreshData: false,
      startBackgroundRefresh: () => Promise.resolve([]),
    };
  }

  const seedUsers = await query.lean();
  let refreshQueued = 0;
  let freshBypass = 0;
  const users = [];
  const refreshJobs = [];
  for (const seedDoc of seedUsers) {
    const shouldRefresh = shouldLoadFreshUserSnapshotForRaidViews(seedDoc, {
      allowAutoManage: false,
    });
    if (!shouldRefresh) {
      // Fresh lean rows are render-only and never enter a refresh job, so
      // weekly normalization can safely happen in place without cloning the
      // full roster tree.
      ensureFreshWeek(seedDoc);
      users.push(seedDoc);
      freshBypass += 1;
      continue;
    }

    // Stale rows still need an isolated render copy because the refresh
    // service receives the untouched seed document in the background.
    const renderDoc = cloneRenderUserDoc(seedDoc);
    if (renderDoc) {
      ensureFreshWeek(renderDoc);
      users.push(renderDoc);
    }
    refreshQueued += 1;
    refreshJobs.push(() =>
      raidCheckRefreshLimiter.run(() =>
        loadFreshUserSnapshotForRaidViews(seedDoc, {
          allowAutoManage: false,
          logLabel: "[raid-check all]",
        })
      )
    );
  }

  let backgroundRefreshPromise = null;
  const startBackgroundRefresh = ({ onUserRefreshed = null } = {}) => {
    if (!backgroundRefreshPromise) {
      backgroundRefreshPromise = Promise.all(
        refreshJobs.map((run) => Promise.resolve()
          .then(run)
          .then((userDoc) => {
            if (userDoc && typeof onUserRefreshed === "function") {
              try {
                onUserRefreshed(userDoc);
              } catch (err) {
                console.warn(
                  "[raid-check all] incremental refresh callback failed:",
                  err?.message || err
                );
              }
            }
            return userDoc;
          })
          .catch(() => null))
      ).then((rows) => rows.filter(Boolean));
    }
    return backgroundRefreshPromise;
  };

  return {
    users,
    refreshQueued,
    freshBypass,
    canRefreshFreshData: true,
    startBackgroundRefresh,
  };
}

function buildAllModePagesData(users) {
  const pagesData = [];
  for (const userDoc of users) {
    const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
    for (let idx = 0; idx < accounts.length; idx += 1) {
      pagesData.push({ userDoc, account: accounts[idx], accountIdx: idx });
    }
  }
  return pagesData;
}

function collectCharacterIds(account) {
  const characters = Array.isArray(account?.characters) ? account.characters : [];
  return new Set(characters.map((character) => character?.id).filter(Boolean));
}

/**
 * Pair the open pages of one user with the accounts of a refreshed document.
 * Accounts carry no _id, so a page follows its normalized accountName first and
 * then a shared character id, because a roster refresh can rename an account.
 * @param {object[]} pages - Open pages of the user.
 * @param {object[]} accounts - Accounts of the refreshed user document.
 * @returns {Map<object, number>} Index in `accounts` for each page that still has an account.
 */
function matchPagesToAccounts(pages, accounts) {
  const accountNames = accounts.map((account) => normalizeName(account?.accountName));
  const accountCharacterIds = accounts.map(collectCharacterIds);
  const indexByPage = new Map();
  const claimed = new Set();
  const claimMatch = (page, isMatch) => {
    if (indexByPage.has(page)) return;
    const accountIdx = accounts.findIndex(
      (_account, index) => !claimed.has(index) && isMatch(index)
    );
    if (accountIdx < 0) return;
    claimed.add(accountIdx);
    indexByPage.set(page, accountIdx);
  };

  for (const page of pages) {
    const name = normalizeName(page.account?.accountName);
    claimMatch(page, (index) => accountNames[index] === name);
  }
  for (const page of pages) {
    const characterIds = collectCharacterIds(page.account);
    claimMatch(page, (index) =>
      [...accountCharacterIds[index]].some((id) => characterIds.has(id))
    );
  }
  return indexByPage;
}

/**
 * Index the all-mode pages by user so a refreshed user document can replace
 * the data the open session renders.
 * @param {object[]} users - Render snapshot rows; the refreshed row replaces its entry.
 * @param {object[]} pagesData - Pages shared with the views; pages whose account
 *   no longer exists are removed in place and the remaining ones get their new accountIdx.
 * @returns {{applyRefreshedUserDoc: function(object): boolean}} Applier that returns
 *   false when the document does not belong to this session.
 */
function createAllModeRefreshIndex(users, pagesData) {
  const userIndexByDiscordId = new Map();
  for (let index = 0; index < users.length; index += 1) {
    const discordId = users[index]?.discordId;
    if (discordId) userIndexByDiscordId.set(String(discordId), index);
  }

  const pagesByDiscordId = new Map();
  for (const page of pagesData) {
    const discordId = page?.userDoc?.discordId;
    if (!discordId) continue;
    const key = String(discordId);
    const userPages = pagesByDiscordId.get(key);
    if (userPages) userPages.push(page);
    else pagesByDiscordId.set(key, [page]);
  }

  const applyRefreshedUserDoc = (userDoc) => {
    if (!userDoc?.discordId || !Array.isArray(userDoc.accounts)) return false;
    const key = String(userDoc.discordId);
    const hasUser = userIndexByDiscordId.has(key);
    const userPages = pagesByDiscordId.get(key) || [];
    if (!hasUser && userPages.length === 0) return false;

    if (hasUser) users[userIndexByDiscordId.get(key)] = userDoc;
    const accountIdxByPage = matchPagesToAccounts(userPages, userDoc.accounts);
    const keptPages = [];
    const droppedPages = new Set();
    for (const page of userPages) {
      const accountIdx = accountIdxByPage.get(page);
      if (accountIdx === undefined) {
        droppedPages.add(page);
        continue;
      }
      page.userDoc = userDoc;
      page.account = userDoc.accounts[accountIdx];
      page.accountIdx = accountIdx;
      keptPages.push(page);
    }
    for (let index = pagesData.length - 1; index >= 0; index -= 1) {
      if (droppedPages.has(pagesData[index])) pagesData.splice(index, 1);
    }
    pagesByDiscordId.set(key, keptPages);
    return true;
  };

  return { applyRefreshedUserDoc };
}

function resolveAllModeAuthorMeta({
  interaction,
  users,
  pagesData,
}) {
  const visibleUserIds = [...new Set(pagesData.map((page) => page.userDoc.discordId))];
  const authorMeta = new Map();
  const usersByDiscordId = new Map(
    users.map((user) => [user.discordId, user])
  );
  const incompleteDiscordIds = [];
  for (const discordId of visibleUserIds) {
    const userDoc = usersByDiscordId.get(discordId);
    const cachedDisplayName =
      userDoc?.discordDisplayName ||
      userDoc?.discordGlobalName ||
      userDoc?.discordUsername ||
      "";
    const member = interaction?.guild?.members?.cache?.get?.(discordId) || null;
    const userObj =
      member?.user || interaction?.client?.users?.cache?.get?.(discordId) || null;
    const resolved = buildDiscordAuthorMeta({
      member,
      user: userObj,
      cachedDisplayName,
    });
    const hasResolvedDisplayName =
      Boolean(resolved.displayName) && resolved.displayName !== discordId;
    if (!hasResolvedDisplayName || !resolved.avatarURL) {
      incompleteDiscordIds.push(discordId);
    }
    authorMeta.set(discordId, {
      displayName: hasResolvedDisplayName ? resolved.displayName : discordId,
      avatarURL: resolved.avatarURL,
    });
  }

  let refreshPromise = null;
  const refreshIncompleteAuthorMeta = () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      let refreshed = 0;
      for (
        let offset = 0;
        offset < incompleteDiscordIds.length;
        offset += AUTHOR_META_FETCH_CONCURRENCY
      ) {
        const batch = incompleteDiscordIds.slice(
          offset,
          offset + AUTHOR_META_FETCH_CONCURRENCY
        );
        const rows = await Promise.all(
          batch.map(async (discordId) => ({
            discordId,
            meta: await fetchDiscordAuthorMeta(interaction, discordId),
          }))
        );
        for (const { discordId, meta } of rows) {
          const current = authorMeta.get(discordId) || {
            displayName: discordId,
            avatarURL: null,
          };
          const hasCurrentDisplayName =
            Boolean(current.displayName) && current.displayName !== discordId;
          const hasFetchedDisplayName =
            Boolean(meta.displayName) && meta.displayName !== discordId;
          const next = {
            displayName: hasCurrentDisplayName
              ? current.displayName
              : hasFetchedDisplayName
                ? meta.displayName
                : discordId,
            avatarURL: meta.avatarURL || current.avatarURL || null,
          };
          if (
            next.displayName === current.displayName &&
            next.avatarURL === current.avatarURL
          ) {
            continue;
          }
          authorMeta.set(discordId, next);
          refreshed += 1;
        }
      }
      return refreshed;
    })();
    return refreshPromise;
  };

  return { visibleUserIds, authorMeta, refreshIncompleteAuthorMeta };
}

module.exports = {
  buildAllModePagesData,
  canRefreshAllModeUsers,
  createAllModeRefreshIndex,
  loadAllModeUsers,
  resolveAllModeAuthorMeta,
  toPlainUserDoc,
};
