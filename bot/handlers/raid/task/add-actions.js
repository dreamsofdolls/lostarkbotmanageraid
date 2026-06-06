"use strict";

const {
  createAddAllHandler,
} = require("./add/add-all");
const {
  createAddSingleHandler,
} = require("./add/add-single");

function createRaidTaskAddActionHandlers(deps) {
  return {
    handleAddSingle: createAddSingleHandler(deps),
    handleAddAll: createAddAllHandler(deps),
  };
}

module.exports = {
  createRaidTaskAddActionHandlers,
};
