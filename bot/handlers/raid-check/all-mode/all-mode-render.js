"use strict";

const {
  isCountedRaidProgress,
  isGoldReceivingRaid,
} = require("../../../utils/raid/common/character");
const { t } = require("../../../services/i18n");
const { isRaidCheckVisibleCharacter, isRaidCheckVisibleRaid } = require("../visibility");
const {
  FILTER_STATUS,
  normalizeAllModeStatusFilter,
  raidMatchesStatusFilter,
} = require("./all-mode-filters");

function createAllModePageRenderers({
  authorMeta,
  buildAccountPageEmbed,
  buildStatusFooterText,
  getState,
  getStatusRaidsForCharacter,
  lang,
  pagesData,
  summarizeRaidProgress,
  truncateText,
}) {
  const raidViewCache = new WeakMap();

  function raidsForPage(userDoc, filterRaidId, filterStatus) {
    const activeStatus = normalizeAllModeStatusFilter(filterStatus);
    let viewsByFilter = raidViewCache.get(userDoc);
    if (!viewsByFilter) {
      viewsByFilter = new Map();
      raidViewCache.set(userDoc, viewsByFilter);
    }
    const cacheKey = JSON.stringify([filterRaidId || null, activeStatus]);
    const cached = viewsByFilter.get(cacheKey);
    if (cached) return cached;

    const statusRaidsCache = new Map();
    const visibleRaidsCache = new Map();
    const getStatusRaidsFor = (character) => {
      let result = statusRaidsCache.get(character);
      if (!result) {
        result = getStatusRaidsForCharacter(character);
        statusRaidsCache.set(character, result);
      }
      return result;
    };
    const getVisibleRaidsFor = (character) => {
      if (visibleRaidsCache.has(character)) return visibleRaidsCache.get(character);
      const result = isRaidCheckVisibleCharacter(character)
        ? getStatusRaidsFor(character).filter(isRaidCheckVisibleRaid)
        : [];
      visibleRaidsCache.set(character, result);
      return result;
    };
    const getRaidsFor = (character) =>
      getVisibleRaidsFor(character).filter(
        (raid) =>
          (!filterRaidId ||
            (`${raid.raidKey}:${raid.modeKey}` === filterRaidId &&
              isGoldReceivingRaid(raid))) &&
          raidMatchesStatusFilter(raid, activeStatus)
      );
    const getProgressRaidsFor = (character) => getRaidsFor(character).filter(isCountedRaidProgress);
    const shouldDisplayCharacter = (character) => getVisibleRaidsFor(character).length > 0;

    const userAccounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
    const userTotalChars = userAccounts.reduce(
      (sum, account) => sum + (Array.isArray(account.characters) ? account.characters.length : 0),
      0
    );
    const allRaidEntries = [];
    for (const account of userAccounts) {
      for (const character of account.characters || []) {
        allRaidEntries.push(...getProgressRaidsFor(character));
      }
    }
    const result = {
      allRaidEntries,
      getRaidsFor,
      getProgressRaidsFor,
      shouldDisplayCharacter,
      globalProgress: summarizeRaidProgress(allRaidEntries),
      userAccounts,
      userTotalChars,
    };
    viewsByFilter.set(cacheKey, result);
    return result;
  }

  function buildRaidPage(pageIndex) {
    const { userDoc, account } = pagesData[pageIndex];
    const {
      filterRaidId,
      filterStatus,
      currentLocalPage,
      filteredIndices,
    } = getState();
    const activeStatus = normalizeAllModeStatusFilter(filterStatus);
    const {
      getRaidsFor,
      getProgressRaidsFor,
      shouldDisplayCharacter,
      globalProgress,
      userAccounts,
      userTotalChars,
    } = raidsForPage(userDoc, filterRaidId, activeStatus);
    const globalTotals = {
      characters: userTotalChars,
      progress: globalProgress,
    };
    const userMeta = {
      discordId: userDoc.discordId,
      autoManageEnabled: !!userDoc.autoManageEnabled,
      localSyncEnabled: !!userDoc.localSyncEnabled,
      lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
      lastAutoManageAttemptAt: Number(userDoc.lastAutoManageAttemptAt) || 0,
    };

    const embed = buildAccountPageEmbed(
      account,
      0,
      1,
      globalTotals,
      getRaidsFor,
      userMeta,
      {
        hideIneligibleChars:
          !!filterRaidId || activeStatus !== FILTER_STATUS.all,
        getProgressRaidsFor,
        lang,
        shouldDisplayCharacter,
        showGoldEarnerHint: false,
      }
    );

    if (userAccounts.length > 1) {
      const rollupLine = t("raid-check.allMode.rollupLine", lang, {
        characters: globalTotals.characters,
        completed: globalTotals.progress.completed,
        total: globalTotals.progress.total,
      });
      const baseDescription = embed.data?.description || "";
      embed.setDescription(baseDescription ? `${rollupLine}\n${baseDescription}` : rollupLine);
    }

    const footerPageInfo = {
      pageIndex: currentLocalPage,
      totalPages: filteredIndices.length,
    };
    embed.setFooter({
      text: buildStatusFooterText(globalTotals, footerPageInfo, lang),
    });

    const meta = authorMeta.get(userDoc.discordId);
    if (meta) {
      const authorPayload = {
        name: truncateText(meta.displayName, 256),
      };
      if (meta.avatarURL) authorPayload.iconURL = meta.avatarURL;
      embed.setAuthor(authorPayload);
    }

    return embed;
  }

  return {
    buildRaidPage,
  };
}

module.exports = {
  createAllModePageRenderers,
};
