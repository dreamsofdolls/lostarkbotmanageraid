"use strict";

const { getClassEmoji } = require("../../../models/Class");
const { t } = require("../../../services/i18n");
const { createGoldViewEmbedBuilder } = require("./gold-ui/embed");
const { createGoldFilterState } = require("./gold-ui/filters");
const { createGoldToggleRows } = require("./gold-ui/toggle-rows");

/**
 * Gold view of /raid-status: its embed, its three selects and the selection
 * the gold handlers write to.
 * @param {object} deps - discord.js builders, UI, account and page getters,
 *   getGoldCharSelection, getRaidsFor, label/format helpers and lang
 * @returns {{buildGoldViewEmbed: Function, buildGoldCharsRow: Function, buildGoldModeRow: Function, buildGoldReceiveRow: Function, selectedGoldEntries: () => Array<{name: string, itemLevel: number, raids: object[]}>}}
 */
function createRaidStatusGoldUi(deps) {
  const context = {
    ...deps,
    lang: deps.lang || "vi",
    getClassEmoji,
    t,
  };
  const filterState = createGoldFilterState(context);
  const {
    buildGoldCharsRow,
    buildGoldModeRow,
    buildGoldReceiveRow,
    selectedEntries,
  } = createGoldToggleRows({
    ...context,
    filterState,
  });

  return {
    buildGoldViewEmbed: createGoldViewEmbedBuilder({
      ...context,
      filterState,
    }),
    buildGoldCharsRow,
    buildGoldModeRow,
    buildGoldReceiveRow,
    // The gold handlers act on the same selection the rows render.
    selectedGoldEntries: selectedEntries,
  };
}

module.exports = {
  createRaidStatusGoldUi,
};
