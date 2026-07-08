"use strict";

const { isSupportClass } = require("../../../models/Class");
const { getRaidModeLabel } = require("../../../utils/raid/common/labels");
const { isGoldProgressRaid } = require("../../../utils/raid/common/character");

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
        if (!isGoldProgressRaid(raid)) continue;
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

module.exports = {
  computeAllModePendingAggregate,
};
