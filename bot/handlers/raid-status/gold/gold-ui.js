"use strict";

const { getClassEmoji } = require("../../../models/Class");
const { t } = require("../../../services/i18n");
const { createGoldViewEmbedBuilder } = require("./gold-ui/embed");
const { createGoldFilterState } = require("./gold-ui/filters");
const { createGoldToggleRows } = require("./gold-ui/toggle-rows");

function createRaidStatusGoldUi(deps) {
  const context = {
    ...deps,
    lang: deps.lang || "vi",
    getClassEmoji,
    t,
  };
  const filterState = createGoldFilterState(context);
  const { buildGoldCharFilterRow, buildGoldToggleRow } = createGoldToggleRows({
    ...context,
    filterState,
  });

  return {
    buildGoldViewEmbed: createGoldViewEmbedBuilder({
      ...context,
      filterState,
    }),
    buildGoldCharFilterRow,
    buildGoldToggleRow,
    goldCharactersOnPage: filterState.goldCharactersOnPage,
    resolveGoldCharFilter: filterState.resolveGoldCharFilter,
  };
}

module.exports = {
  createRaidStatusGoldUi,
};
