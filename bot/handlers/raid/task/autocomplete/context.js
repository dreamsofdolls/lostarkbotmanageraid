"use strict";

function createRaidTaskAutocompleteContext({
  loadUserForAutocomplete,
  resolveTaskWriteTarget,
}) {
  async function loadUserDocForRosterAutocomplete(executorId, rosterName) {
    if (!rosterName) {
      return loadUserForAutocomplete(executorId);
    }
    const writeTarget = await resolveTaskWriteTarget(executorId, rosterName);
    if (writeTarget.viaShare) {
      const ownerDoc = await loadUserForAutocomplete(writeTarget.discordId);
      if (ownerDoc && Array.isArray(ownerDoc.accounts)) {
        return ownerDoc;
      }
    }
    return loadUserForAutocomplete(executorId);
  }

  return {
    loadUserDocForRosterAutocomplete,
  };
}

module.exports = {
  createRaidTaskAutocompleteContext,
};
