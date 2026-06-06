"use strict";

async function resolvePreSelectedDisplayName({
  scopeAll,
  preSelectedUserId,
  User,
  interaction,
  resolveDiscordDisplay,
  logger = console,
}) {
  if (!scopeAll || !preSelectedUserId) return null;
  try {
    const preDoc = await User.findOne({ discordId: preSelectedUserId })
      .select("discordUsername discordGlobalName discordDisplayName")
      .lean();
    const cached =
      preDoc?.discordDisplayName ||
      preDoc?.discordGlobalName ||
      preDoc?.discordUsername ||
      "";
    if (cached) return cached;
    return resolveDiscordDisplay(interaction.client, preSelectedUserId);
  } catch (err) {
    logger.warn(
      `[raid-check edit scopeAll] pre-select display resolve failed for ${preSelectedUserId}:`,
      err?.message || err
    );
    return preSelectedUserId;
  }
}

async function loadEditableRaidContext({
  raidMeta,
  computeRaidCheckSnapshot,
  buildEditableCharsByUser,
  resolveCachedDisplayName,
  client,
}) {
  const snapshot = await computeRaidCheckSnapshot(raidMeta, {
    syncFreshData: true,
  });
  const editableByUser = buildEditableCharsByUser(snapshot);
  const displayMap = new Map();
  await Promise.all(
    [...editableByUser.keys()].map(async (discordId) => {
      const meta = snapshot.userMeta.get(discordId) || {};
      const name = await resolveCachedDisplayName(client, discordId, meta);
      displayMap.set(discordId, name);
    })
  );
  return { snapshot, editableByUser, displayMap };
}

function createRaidCheckEditState({
  scopeAll,
  lang,
  raidMeta,
  raidKey,
  editableByUser,
  displayMap,
  preSelectedUserId,
  preSelectedDisplayName,
}) {
  return {
    scopeAll,
    lang,
    raidMeta: raidMeta || null,
    editableByUser,
    displayMap,
    preSelectedUserId: scopeAll ? preSelectedUserId : null,
    preSelectedDisplayName,
    selectedUser: null,
    selectedChar: null,
    selectedRaid: raidKey || null,
    awaitingGate: false,
    applied: false,
    locked: false,
    message: null,
    warning: null,
  };
}

function getOpenedRaidLabel({ scopeAll, raidMeta }) {
  return scopeAll ? "all" : `${raidMeta.raidKey}:${raidMeta.modeKey}`;
}

module.exports = {
  createRaidCheckEditState,
  getOpenedRaidLabel,
  loadEditableRaidContext,
  resolvePreSelectedDisplayName,
};
