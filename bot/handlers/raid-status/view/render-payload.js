"use strict";

const { loadBackgroundBuffer } = require("../../../services/raid-card/bg-loader");
const {
  getRaidFilterKey,
  isCountedRaidFilterProgress,
} = require("../raid-filter");
const { resolveBackgroundLookup } = require("./accounts");

function createRaidStatusRenderPayload({
  discordId,
  getAccounts,
  getCurrentPage,
  getCurrentLocalPage = getCurrentPage,
  getVisibleRosterCount = () => getAccounts().length,
  getCurrentView,
  getFilterRaidId,
  getStatusUserMeta,
  baseGetRaidsFor,
  totalCharacters,
  getTotalCharacters = () => totalCharacters,
  summarizeRaidProgress,
  summarizeGlobalGold,
  buildAccountPageEmbed,
  buildGoldViewEmbed,
  buildTaskViewEmbed,
  lang,
}) {
  const backgroundBufferCache = new Map();
  const globalTotalsCache = new WeakMap();

  const resolveBackgroundBuffer = async (account) => {
    const lookup = resolveBackgroundLookup(discordId, account);
    const { cacheKey } = lookup;
    if (backgroundBufferCache.has(cacheKey)) return backgroundBufferCache.get(cacheKey);
    const buffer = await loadBackgroundBuffer(lookup.discordId, {
      accountName: lookup.accountName,
    });
    backgroundBufferCache.set(cacheKey, buffer);
    return buffer;
  };

  const buildCurrentEmbed = () => {
    const accounts = getAccounts();
    const currentPage = getCurrentPage();
    const currentView = getCurrentView();
    const filterRaidId = getFilterRaidId();

    if (currentView === "task") {
      return buildTaskViewEmbed(accounts[currentPage]);
    }
    if (currentView === "gold") {
      return buildGoldViewEmbed(accounts[currentPage]);
    }

    const getProgressRaidsFor = (ch) =>
      baseGetRaidsFor(ch).filter(isCountedRaidFilterProgress);
    const getDisplayRaidsFor = filterRaidId
      ? (ch) =>
          baseGetRaidsFor(ch).filter(
            (r) => getRaidFilterKey(r) === filterRaidId
          )
      : baseGetRaidsFor;
    const getCountRaidsFor = filterRaidId
      ? (ch) =>
          getProgressRaidsFor(ch).filter(
            (r) => getRaidFilterKey(r) === filterRaidId
          )
      : getProgressRaidsFor;

    let totalsByFilter = globalTotalsCache.get(accounts);
    if (!totalsByFilter) {
      totalsByFilter = new Map();
      globalTotalsCache.set(accounts, totalsByFilter);
    }
    const totalsKey = filterRaidId || null;
    let filteredTotals = totalsByFilter.get(totalsKey);
    if (!filteredTotals) {
      const filteredEntries = [];
      for (const account of accounts) {
        for (const character of account.characters || []) {
          filteredEntries.push(...getCountRaidsFor(character));
        }
      }
      filteredTotals = {
        characters: getTotalCharacters(),
        progress: summarizeRaidProgress(filteredEntries),
        gold: summarizeGlobalGold(accounts, getDisplayRaidsFor),
      };
      totalsByFilter.set(totalsKey, filteredTotals);
    }

    return buildAccountPageEmbed(
      accounts[currentPage],
      getCurrentLocalPage(),
      getVisibleRosterCount(),
      filteredTotals,
      getDisplayRaidsFor,
      getStatusUserMeta(),
      {
        hideIneligibleChars: !!filterRaidId,
        getProgressRaidsFor: getCountRaidsFor,
        showCharacterGold: !filterRaidId,
        lang,
      }
    );
  };

  const buildEmbedAndCanvas = async () => {
    const embed = buildCurrentEmbed();
    const payload = { embeds: [embed], files: [], attachments: [] };
    const attachBackgroundToStatusEmbed = (buffer) => {
      const name = "raid-background.jpg";
      embed.setImage(`attachment://${name}`);
      payload.files = [{ attachment: buffer, name }];
      return payload;
    };

    if (getCurrentView() === "task") return payload;
    const account = getAccounts()[getCurrentPage()];
    const bgBuffer = await resolveBackgroundBuffer(account);
    if (!bgBuffer) return payload;
    return attachBackgroundToStatusEmbed(bgBuffer);
  };

  return {
    buildCurrentEmbed,
    buildEmbedAndCanvas,
  };
}

module.exports = {
  createRaidStatusRenderPayload,
};
