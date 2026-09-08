"use strict";

const { loadBackgroundBuffer } = require("../../../services/raid-card/bg-loader");
const {
  getRaidFilterKey,
  isCountedRaidFilterProgress,
  summarizeSoloRaidProgress,
} = require("../raid-filter");
const {
  isGoldReceivingRaid,
} = require("../../../utils/raid/common/character");
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
  buildLocalSyncViewEmbed = () => null,
  lang,
}) {
  const backgroundBufferCache = new Map();
  const globalTotalsCache = new WeakMap();
  const accountViewEmbedByName = new Map([
    ["task", buildTaskViewEmbed],
    ["gold", buildGoldViewEmbed],
  ]);

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

    const accountViewEmbed = accountViewEmbedByName.get(currentView);
    if (accountViewEmbed) return accountViewEmbed(accounts[currentPage]);
    if (currentView === "sync") {
      // Falls through to the raid embed when the snapshot has not loaded
      // yet · the collector's "end" hook re-renders from here and must
      // never throw on a session that expired mid-fetch.
      const syncEmbed = buildLocalSyncViewEmbed();
      if (syncEmbed) return syncEmbed;
    }

    // Totals, gold summaries and character fields reuse the same filtered rows.
    // Keep this cache within one render so later edits always see fresh state.
    const raidViews = new Map();
    const getRaidView = (character) => {
      if (raidViews.has(character)) return raidViews.get(character);
      const raids = baseGetRaidsFor(character);
      const matching = filterRaidId
        ? raids.filter((raid) => getRaidFilterKey(raid) === filterRaidId)
        : raids;
      const view = {
        display: filterRaidId ? matching.filter(isGoldReceivingRaid) : raids,
        progress: matching.filter(isCountedRaidFilterProgress),
      };
      raidViews.set(character, view);
      return view;
    };
    const getDisplayRaidsFor = (character) => getRaidView(character).display;
    const getCountRaidsFor = (character) => getRaidView(character).progress;

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
      const soloProgress = summarizeSoloRaidProgress(accounts, getDisplayRaidsFor);
      filteredTotals = {
        characters: getTotalCharacters(),
        progress: summarizeRaidProgress(filteredEntries),
        // Preserve the numeric total for existing consumers while exposing
        // completed/total to the headline renderer.
        solo: soloProgress.total,
        soloProgress,
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

    // Task and sync views render plain cards · loading a roster
    // background for them costs a disk/network read for an image the
    // embed never shows.
    const view = getCurrentView();
    if (view === "task" || view === "sync") return payload;
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
