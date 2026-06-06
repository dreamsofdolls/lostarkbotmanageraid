"use strict";

const { loadBackgroundBuffer } = require("../../services/raid-card/bg-loader");
const { resolveBackgroundLookup } = require("./accounts");

function createRaidStatusRenderPayload({
  discordId,
  getAccounts,
  getCurrentPage,
  getCurrentView,
  getFilterRaidId,
  getStatusUserMeta,
  baseGetRaidsFor,
  totalCharacters,
  summarizeRaidProgress,
  summarizeGlobalGold,
  buildAccountPageEmbed,
  buildTaskViewEmbed,
  lang,
}) {
  const backgroundBufferCache = new Map();

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

    const getRaidsFor = filterRaidId
      ? (ch) =>
          baseGetRaidsFor(ch).filter(
            (r) => `${r.raidKey}:${r.modeKey}` === filterRaidId
          )
      : baseGetRaidsFor;

    const filteredEntries = [];
    for (const account of accounts) {
      for (const character of account.characters || []) {
        filteredEntries.push(...getRaidsFor(character));
      }
    }

    const filteredTotals = {
      characters: totalCharacters,
      progress: summarizeRaidProgress(filteredEntries),
      gold: summarizeGlobalGold(accounts, getRaidsFor),
    };

    return buildAccountPageEmbed(
      accounts[currentPage],
      currentPage,
      accounts.length,
      filteredTotals,
      getRaidsFor,
      getStatusUserMeta(),
      { hideIneligibleChars: !!filterRaidId, lang }
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
