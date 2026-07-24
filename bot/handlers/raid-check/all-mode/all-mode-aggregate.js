"use strict";

const { isSupportClass } = require("../../../models/Class");
const { getRaidModeLabel } = require("../../../utils/raid/common/labels");
const { isCountedRaidProgress } = require("../../../utils/raid/common/character");
const { isRaidCheckVisibleRaid } = require("../visibility");

function createRoleTally() {
  return { count: 0, supports: 0, dps: 0 };
}

function addPendingRole(tally, isSupport) {
  tally.count += 1;
  if (isSupport) {
    tally.supports += 1;
  } else {
    tally.dps += 1;
  }
}

function getRaidEntry({ perRaidPending, raid, lang }) {
  const key = `${raid.raidKey}:${raid.modeKey}`;
  let entry = perRaidPending.get(key);
  if (!entry) {
    entry = {
      key,
      label: getRaidModeLabel(raid.raidKey, raid.modeKey, lang),
      // raidKey/modeKey kept so the raid dropdown can sort by canonical
      // progression order (compareRaidModeOrder) instead of pending count.
      raidKey: raid.raidKey,
      modeKey: raid.modeKey,
      pending: 0,
      supports: 0,
      dps: 0,
    };
    perRaidPending.set(key, entry);
  }
  return entry;
}

function computeAllModePendingAggregate({
  pagesData,
  raidFilter = null,
  userFilter = null,
  getStatusRaidsForCharacter,
  lang = "vi",
}) {
  const perUserPending = new Map();
  const perRaidPending = new Map();
  let totalPending = 0;

  for (const page of pagesData || []) {
    const discordId = page?.userDoc?.discordId;
    if (!discordId) continue;
    if (userFilter && discordId !== userFilter) continue;

    const chars = Array.isArray(page?.account?.characters)
      ? page.account.characters
      : [];
    for (const character of chars) {
      const charIsSupport = isSupportClass(character?.class);
      for (const raid of getStatusRaidsForCharacter(character) || []) {
        if (!isRaidCheckVisibleRaid(raid)) continue;
        if (!isCountedRaidProgress(raid)) continue;
        const raidEntry = getRaidEntry({ perRaidPending, raid, lang });
        if (raidFilter && raidEntry.key !== raidFilter) continue;
        if (raid.isCompleted) continue;

        let userEntry = perUserPending.get(discordId);
        if (!userEntry) {
          userEntry = createRoleTally();
          perUserPending.set(discordId, userEntry);
        }

        addPendingRole(userEntry, charIsSupport);
        raidEntry.pending += 1;
        if (charIsSupport) {
          raidEntry.supports += 1;
        } else {
          raidEntry.dps += 1;
        }
        totalPending += 1;
      }
    }
  }

  return { perUserPending, perRaidPending, totalPending };
}

/**
 * Cache pending aggregates and per-character raid derivation for one all-mode
 * interaction session. Call clear after the backing roster data changes.
 * @param {object} options - Session data and raid derivation dependencies.
 * @returns {object} Cached compute, raid lookup, and invalidation functions.
 */
function createAllModePendingAggregateCache({
  pagesData,
  getStatusRaidsForCharacter,
  lang = "vi",
}) {
  const aggregateCache = new Map();
  const characterRaidsCache = new Map();
  let pendingIndex = null;

  const getCachedRaidsForCharacter = (character) => {
    if (characterRaidsCache.has(character)) {
      return characterRaidsCache.get(character);
    }
    const raids = getStatusRaidsForCharacter(character);
    characterRaidsCache.set(character, raids);
    return raids;
  };

  const buildPendingIndex = () => {
    if (pendingIndex) return pendingIndex;

    const perUserPending = new Map();
    const perRaidPending = new Map();
    const pendingByUserRaid = new Map();
    const raidKeysByUser = new Map();
    let totalPending = 0;

    for (const page of pagesData || []) {
      const discordId = page?.userDoc?.discordId;
      if (!discordId) continue;

      let userRaidKeys = raidKeysByUser.get(discordId);
      if (!userRaidKeys) {
        userRaidKeys = new Set();
        raidKeysByUser.set(discordId, userRaidKeys);
      }

      const chars = Array.isArray(page?.account?.characters)
        ? page.account.characters
        : [];
      for (const character of chars) {
        const charIsSupport = isSupportClass(character?.class);
        for (const raid of getCachedRaidsForCharacter(character) || []) {
          if (!isRaidCheckVisibleRaid(raid)) continue;
          if (!isCountedRaidProgress(raid)) continue;

          const raidEntry = getRaidEntry({ perRaidPending, raid, lang });
          userRaidKeys.add(raidEntry.key);
          if (raid.isCompleted) continue;

          let userEntry = perUserPending.get(discordId);
          if (!userEntry) {
            userEntry = createRoleTally();
            perUserPending.set(discordId, userEntry);
          }
          addPendingRole(userEntry, charIsSupport);

          let userRaidMap = pendingByUserRaid.get(discordId);
          if (!userRaidMap) {
            userRaidMap = new Map();
            pendingByUserRaid.set(discordId, userRaidMap);
          }
          let userRaidEntry = userRaidMap.get(raidEntry.key);
          if (!userRaidEntry) {
            userRaidEntry = createRoleTally();
            userRaidMap.set(raidEntry.key, userRaidEntry);
          }
          addPendingRole(userRaidEntry, charIsSupport);

          raidEntry.pending += 1;
          if (charIsSupport) raidEntry.supports += 1;
          else raidEntry.dps += 1;
          totalPending += 1;
        }
      }
    }

    pendingIndex = {
      perUserPending,
      perRaidPending,
      pendingByUserRaid,
      raidKeysByUser,
      totalPending,
    };
    return pendingIndex;
  };

  const copyRaidEntry = (entry, tally = null) => ({
    ...entry,
    pending: tally?.count || 0,
    supports: tally?.supports || 0,
    dps: tally?.dps || 0,
  });

  const computeFromIndex = ({ raidFilter = null, userFilter = null } = {}) => {
    const index = buildPendingIndex();
    if (!raidFilter && !userFilter) {
      return {
        perUserPending: index.perUserPending,
        perRaidPending: index.perRaidPending,
        totalPending: index.totalPending,
      };
    }

    const perUserPending = new Map();
    const perRaidPending = new Map();
    let totalPending = 0;

    if (userFilter) {
      const userRaidMap = index.pendingByUserRaid.get(userFilter);
      const selectedTally = raidFilter
        ? userRaidMap?.get(raidFilter)
        : index.perUserPending.get(userFilter);
      if (selectedTally?.count > 0) {
        perUserPending.set(userFilter, selectedTally);
        totalPending = selectedTally.count;
      }

      const raidKeys = index.raidKeysByUser.get(userFilter) || [];
      for (const raidKey of raidKeys) {
        const baseEntry = index.perRaidPending.get(raidKey);
        if (!baseEntry) continue;
        const tally =
          !raidFilter || raidKey === raidFilter
            ? userRaidMap?.get(raidKey)
            : null;
        perRaidPending.set(raidKey, copyRaidEntry(baseEntry, tally));
      }
    } else {
      for (const [discordId, userRaidMap] of index.pendingByUserRaid) {
        const tally = userRaidMap.get(raidFilter);
        if (tally?.count > 0) perUserPending.set(discordId, tally);
      }
      const selectedRaid = index.perRaidPending.get(raidFilter);
      totalPending = selectedRaid?.pending || 0;
      for (const [raidKey, baseEntry] of index.perRaidPending) {
        const tally =
          raidKey === raidFilter
            ? {
                count: baseEntry.pending,
                supports: baseEntry.supports,
                dps: baseEntry.dps,
              }
            : null;
        perRaidPending.set(raidKey, copyRaidEntry(baseEntry, tally));
      }
    }

    return { perUserPending, perRaidPending, totalPending };
  };

  const compute = ({ raidFilter = null, userFilter = null } = {}) => {
    const cacheKey = JSON.stringify([raidFilter, userFilter]);
    if (aggregateCache.has(cacheKey)) return aggregateCache.get(cacheKey);

    const aggregate = computeFromIndex({ raidFilter, userFilter });
    aggregateCache.set(cacheKey, aggregate);
    return aggregate;
  };

  const clear = () => {
    aggregateCache.clear();
    characterRaidsCache.clear();
    pendingIndex = null;
  };

  return {
    clear,
    compute,
    getRaidsForCharacter: getCachedRaidsForCharacter,
  };
}

module.exports = {
  createAllModePendingAggregateCache,
  computeAllModePendingAggregate,
};
