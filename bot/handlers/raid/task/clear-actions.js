"use strict";

const {
  buildClearConfirmRow,
} = require("./clear/components");
const {
  createClearCancelHandler,
  createClearConfirmHandler,
} = require("./clear/confirm");
const {
  createClearPreviewHandler,
} = require("./clear/preview");

function createRaidTaskClearActionHandlers(deps) {
  return {
    handleClear: createClearPreviewHandler(deps),
    handleClearConfirmButton: createClearConfirmHandler(deps),
    handleClearCancelButton: createClearCancelHandler(deps),
  };
}

module.exports = {
  buildClearConfirmRow,
  createRaidTaskClearActionHandlers,
};
