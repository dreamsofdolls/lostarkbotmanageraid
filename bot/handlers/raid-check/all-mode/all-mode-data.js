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
    };
  }

  const seedUsers = await query;
  let refreshQueued = 0;
  let freshBypass = 0;
  const users = (
    await Promise.all(
      seedUsers.map((seedDoc) => {
        const shouldRefresh =
          typeof shouldLoadFreshUserSnapshotForRaidViews === "function"
            ? shouldLoadFreshUserSnapshotForRaidViews(seedDoc, {
                allowAutoManage: false,
              })
            : true;
        if (!shouldRefresh) {
          freshBypass += 1;
          return Promise.resolve(toPlainUserDoc(seedDoc));
        }
        refreshQueued += 1;
        return raidCheckRefreshLimiter.run(() =>
          loadFreshUserSnapshotForRaidViews(seedDoc, {
            allowAutoManage: false,
            logLabel: "[raid-check all]",
          })
        );
      })
    )
  ).filter(Boolean);

  return {
    users,
    refreshQueued,
    freshBypass,
    canRefreshFreshData: true,
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

async function resolveAllModeAuthorMeta({
  interaction,
  users,
  pagesData,
  discordUserLimiter,
}) {
  const visibleUserIds = [...new Set(pagesData.map((page) => page.userDoc.discordId))];
  const authorMeta = new Map();
  const usersByDiscordId = new Map(
    users.map((user) => [user.discordId, user])
  );
  await Promise.all(
    visibleUserIds.map(async (discordId) => {
      const userDoc = usersByDiscordId.get(discordId);
      const cachedDisplayName =
        userDoc?.discordDisplayName ||
        userDoc?.discordGlobalName ||
        userDoc?.discordUsername ||
        "";
      let displayName = cachedDisplayName || discordId;
      let avatarURL = null;
      try {
        let userObj = interaction.client.users.cache.get(discordId);
        // A persisted name already covers every text surface. Avoid a Discord
        // REST fan-out solely for an optional avatar on a cold client cache.
        if (!userObj && !cachedDisplayName) {
          userObj = await discordUserLimiter.run(() =>
            interaction.client.users.fetch(discordId)
          );
        }
        if (userObj) {
          avatarURL = userObj.displayAvatarURL({ size: 64 });
          if (!cachedDisplayName) {
            displayName = userObj.username || displayName;
          }
        }
      } catch {
        // Fallback to cached name / snowflake; avatar stays null.
      }
      authorMeta.set(discordId, { displayName, avatarURL });
    })
  );
  return { visibleUserIds, authorMeta };
}

module.exports = {
  buildAllModePagesData,
  canRefreshAllModeUsers,
  loadAllModeUsers,
  resolveAllModeAuthorMeta,
  toPlainUserDoc,
};
