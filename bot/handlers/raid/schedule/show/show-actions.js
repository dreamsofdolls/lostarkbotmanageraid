"use strict";

const {
  createScheduleShowResurfaceActions,
} = require("./show-resurface");
const {
  createScheduleShowSelectActions,
} = require("./show-selects");

function createScheduleShowActions(deps) {
  const {
    handleShowResurface,
    handleShowTurnPlan,
  } = createScheduleShowResurfaceActions(deps);
  const {
    handleShowPickSelect,
    handleShowTpSelect,
  } = createScheduleShowSelectActions(deps);

  const SHOW_ACTION_HANDLERS = Object.freeze({
    resurface: handleShowResurface,
    turnplan: handleShowTurnPlan,
  });

  async function handleShowCommand(interaction) {
    const action = interaction.options.getString("action") || "resurface";
    const handler = SHOW_ACTION_HANDLERS[action] || handleShowResurface;
    return handler(interaction);
  }

  return {
    handleShowCommand,
    handleShowPickSelect,
    handleShowTpSelect,
  };
}

module.exports = {
  createScheduleShowActions,
};
