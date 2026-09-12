"use strict";

const { createSharedAddHandler } = require("./shared/shared-add");
const { createTaskRemoveHandler } = require("./remove-actions");

function createRaidTaskSharedActionHandlers(deps) {
  return {
    handleSharedAdd: createSharedAddHandler(deps),
    handleSharedRemove: createTaskRemoveHandler(deps, { shared: true }),
  };
}

module.exports = { createRaidTaskSharedActionHandlers };
