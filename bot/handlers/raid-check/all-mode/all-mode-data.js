"use strict";

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
  loadAllModeUsers,
  resolveAllModeAuthorMeta,
  toPlainUserDoc,
};
