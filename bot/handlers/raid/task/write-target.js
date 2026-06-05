"use strict";

const {
  findAccountInUser,
  resolveTaskWriteTargetFromAccessible,
} = require("../../../utils/raid/tasks/side-tasks");

function createRaidTaskWriteTargetResolver({
  loadUserForAutocomplete,
  getAccessibleAccounts,
  logger = console,
}) {
  return async function resolveTaskWriteTarget(executorId, rosterName) {
    if (!rosterName) {
      return { discordId: executorId, viaShare: false };
    }

    try {
      const ownDoc = await loadUserForAutocomplete(executorId);
      if (findAccountInUser(ownDoc, rosterName)) {
        return { discordId: executorId, viaShare: false };
      }
    } catch (err) {
      logger.warn?.("[raid-task] own roster lookup failed:", err?.message || err);
    }

    let accessible = [];
    try {
      accessible = await getAccessibleAccounts(executorId);
    } catch (err) {
      logger.warn?.("[raid-task] getAccessibleAccounts failed:", err?.message || err);
      return { discordId: executorId, viaShare: false };
    }

    return resolveTaskWriteTargetFromAccessible(executorId, rosterName, accessible);
  };
}

module.exports = {
  createRaidTaskWriteTargetResolver,
};
