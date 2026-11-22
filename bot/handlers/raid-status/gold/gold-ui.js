"use strict";

const { getClassEmoji } = require("../../../models/Class");
const { t } = require("../../../services/i18n");
const { createGoldViewEmbedBuilder } = require("./gold-ui/embed");
const { createGoldFilterState } = require("./gold-ui/filters");
const { createGoldToggleRows } = require("./gold-ui/toggle-rows");

/**
 * Gold view of /raid-status: its embed, its selects (gold set, difficulty,
 * and raid visibility), its reset/sub-view buttons and the selections the
 * gold handlers write to.
 * @param {object} deps - discord.js builders, UI, account and page getters,
 *   getGoldCharSelection, getVisibilityCharSelection, getGoldSubView,
 *   getRaidsFor, label/format helpers and lang
 * @returns {object}
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
    buildGoldResetButton,
    buildGoldSubViewButton,
    buildVisibilityCharsRow,
    buildVisibilityRaidsRow,
    buildVisibilityResetButton,
    selectedEntries,
    selectedVisibilityEntries,
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
    buildGoldResetButton,
    buildGoldSubViewButton,
    buildVisibilityCharsRow,
    buildVisibilityRaidsRow,
    buildVisibilityResetButton,
    // The gold handlers act on the same selection the rows render.
    selectedGoldEntries: selectedEntries,
    selectedVisibilityEntries,
  };
}

module.exports = {
  createRaidStatusGoldUi,
};
