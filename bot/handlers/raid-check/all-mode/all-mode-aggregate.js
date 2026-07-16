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

  const getCachedRaidsForCharacter = (character) => {
    if (characterRaidsCache.has(character)) {
      return characterRaidsCache.get(character);
    }
    const raids = getStatusRaidsForCharacter(character);
    characterRaidsCache.set(character, raids);
    return raids;
  };

  const compute = ({ raidFilter = null, userFilter = null } = {}) => {
    const cacheKey = JSON.stringify([raidFilter, userFilter]);
    if (aggregateCache.has(cacheKey)) return aggregateCache.get(cacheKey);

    const aggregate = computeAllModePendingAggregate({
      pagesData,
      raidFilter,
      userFilter,
      getStatusRaidsForCharacter: getCachedRaidsForCharacter,
      lang,
    });
    aggregateCache.set(cacheKey, aggregate);
    return aggregate;
  };

  const clear = () => {
    aggregateCache.clear();
    characterRaidsCache.clear();
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
