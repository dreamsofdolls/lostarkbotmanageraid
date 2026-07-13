"use strict";

function toPlainUserDoc(userDoc) {
  if (!userDoc) return null;
  return typeof userDoc.toObject === "function" ? userDoc.toObject() : userDoc;
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

  const seedUsers = await query;
  let refreshQueued = 0;
  let freshBypass = 0;
  const users = [];
  const refreshJobs = [];
  for (const seedDoc of seedUsers) {
    const shouldRefresh =
      typeof shouldLoadFreshUserSnapshotForRaidViews === "function"
        ? shouldLoadFreshUserSnapshotForRaidViews(seedDoc, {
            allowAutoManage: false,
          })
        : true;
    const renderDoc = toPlainUserDoc(seedDoc);
    if (renderDoc) {
      ensureFreshWeek(renderDoc);
      users.push(renderDoc);
    }
    if (!shouldRefresh) {
      freshBypass += 1;
      continue;
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
  const startBackgroundRefresh = () => {
    if (!backgroundRefreshPromise) {
      backgroundRefreshPromise = Promise.all(
        refreshJobs.map((run) => Promise.resolve().then(run).catch(() => null))
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
  for (const discordId of visibleUserIds) {
    const userDoc = usersByDiscordId.get(discordId);
    const cachedDisplayName =
      userDoc?.discordDisplayName ||
      userDoc?.discordGlobalName ||
      userDoc?.discordUsername ||
      "";
    let displayName = cachedDisplayName || discordId;
    let avatarURL = null;
    const userObj = interaction.client.users.cache.get(discordId);
    if (userObj) {
      avatarURL = userObj.displayAvatarURL({ size: 64 });
      if (!cachedDisplayName) {
        displayName = userObj.globalName || userObj.username || displayName;
      }
    }
    authorMeta.set(discordId, { displayName, avatarURL });
  }
  return { visibleUserIds, authorMeta };
}

module.exports = {
  buildAllModePagesData,
  canRefreshAllModeUsers,
  loadAllModeUsers,
  resolveAllModeAuthorMeta,
  toPlainUserDoc,
};
