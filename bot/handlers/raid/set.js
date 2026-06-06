"use strict";

const { replyEmbed, replyNotice } = require("../../utils/raid/common/shared");
const {
  getAccessibleAccounts,
  canEditAccount,
} = require("../../services/access/access-control");
const { t, getUserLanguage } = require("../../services/i18n");
const { createRosterOwnerResolver } = require("../../services/raid/roster-owner-resolver");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");
const {
  findCharacterInUser: findCharacterEntryInUser,
} = require("../../utils/raid/tasks/side-tasks");
const { createRaidSetApplyService } = require("./set/apply");
const { createRaidSetAutocompleteService } = require("./set/autocomplete");
const { createRaidSetInputHelpers } = require("./set/command-input");
const { createRaidSetResultResponder } = require("./set/command-result");

function createRaidSetCommand(deps) {
  const {
    EmbedBuilder,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    normalizeName,
    getCharacterName,
    getCharacterClass,
    createCharacterId,
    loadUserForAutocomplete,
    loadAccountsRegisteredBy = async () => [],
    getRaidRequirementList,
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    ensureAssignedRaids,
    normalizeAssignedRaid,
    getGateKeys,
    toModeLabel,
  } = deps;

  const { flattenRegisteredAccounts, resolveRosterOwner } = createRosterOwnerResolver({
    User,
    normalizeName,
    loadUserForAutocomplete,
    loadAccountsRegisteredBy,
    getAccessibleAccounts,
  });

  function findCharacterInUser(userDoc, characterName, rosterName = null) {
    return findCharacterEntryInUser(userDoc, characterName, rosterName)?.character || null;
  }

  const {
    makeRaidSetResult,
    applyRaidSetToLoadedUserDoc,
  } = createRaidSetApplyService({
    canEditAccount,
    normalizeName,
    getCharacterName,
    getCharacterClass,
    createCharacterId,
    ensureAssignedRaids,
    normalizeAssignedRaid,
    getGateKeys,
    getGatesForRaid,
    toModeLabel,
    findCharacterInUser,
  });

  const { handleRaidSetAutocomplete } = createRaidSetAutocompleteService({
    UI,
    User,
    normalizeName,
    loadUserForAutocomplete,
    getAccessibleAccounts,
    flattenRegisteredAccounts,
    resolveRosterOwner,
    loadAccountsRegisteredBy,
    getRaidRequirementList,
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    ensureAssignedRaids,
    getGateKeys,
    toModeLabel,
    findCharacterInUser,
  });

  const {
    localizedRaidLabel: buildLocalizedRaidLabel,
    readRaidSetInput,
    validateRaidSetInput,
  } = createRaidSetInputHelpers({
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    getRaidModeLabel,
    t,
  });

  const {
    replyRaidSetResult,
    replyRosterOwnerFailure,
  } = createRaidSetResultResponder({
    EmbedBuilder,
    UI,
    t,
  });

  async function applyRaidSetForDiscordId({
    discordId,
    executorId = null,
    characterName,
    rosterName = null,
    raidMeta,
    statusType,
    effectiveGates,
    requireLocalSyncEnabled = false,
  }) {
    let result = makeRaidSetResult(raidMeta);
    await saveWithRetry(async () => {
      result = makeRaidSetResult(raidMeta);
      const userDoc = await User.findOne({ discordId });
      if (userDoc) ensureFreshWeek(userDoc);
      result = await applyRaidSetToLoadedUserDoc(userDoc, {
        discordId,
        executorId,
        characterName,
        rosterName,
        raidMeta,
        statusType,
        effectiveGates,
        requireLocalSyncEnabled,
      });
      if (result.updated) await userDoc.save();
    });
    return result;
  }

  async function applyRaidSetBatchForDiscordId({
    discordId,
    entries,
    requireLocalSyncEnabled = false,
  }) {
    const list = Array.isArray(entries) ? entries : [];
    let results = list.map((entry) => makeRaidSetResult(entry?.raidMeta));
    await saveWithRetry(async () => {
      results = [];
      const userDoc = await User.findOne({ discordId });
      if (!userDoc) {
        results = list.map((entry) => ({
          ...makeRaidSetResult(entry?.raidMeta),
          noRoster: true,
        }));
        return;
      }

      ensureFreshWeek(userDoc);
      const now = Date.now();
      let didUpdate = false;
      for (const entry of list) {
        const result = await applyRaidSetToLoadedUserDoc(userDoc, {
          discordId,
          executorId: entry.executorId || null,
          characterName: entry.characterName,
          rosterName: entry.rosterName || null,
          raidMeta: entry.raidMeta,
          statusType: entry.statusType || "process",
          effectiveGates: entry.effectiveGates,
          requireLocalSyncEnabled,
        }, now);
        results.push(result);
        if (result.updated) didUpdate = true;
      }

      if (didUpdate) {
        if (typeof userDoc.markModified === "function") userDoc.markModified("accounts");
        await userDoc.save();
      }
    });
    return results;
  }

  async function handleRaidSetCommand(interaction) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const replySetNotice = (options, extras) =>
      replyNotice(interaction, EmbedBuilder, options, extras);
    const replySetEmbed = (embed, extras) => replyEmbed(interaction, embed, extras);

    const input = readRaidSetInput(interaction);
    const { rosterName, characterName, raidKey, statusType } = input;
    const validation = validateRaidSetInput(input, lang);
    if (!validation.valid) {
      await replySetNotice(validation.notice);
      return;
    }
    const { raidMeta, effectiveGate } = validation;

    const resolvedOwner = await resolveRosterOwner(executorId, rosterName);
    if (await replyRosterOwnerFailure({ replySetNotice, resolvedOwner, lang, rosterName })) {
      return;
    }

    const targetDiscordId = resolvedOwner.ownerDiscordId;
    const actingForOther = resolvedOwner.actingForOther;
    const ownerLabel = resolvedOwner.ownerLabel;

    const result = await applyRaidSetForDiscordId({
      discordId: targetDiscordId,
      executorId,
      characterName,
      rosterName,
      raidMeta,
      statusType,
      effectiveGates: effectiveGate ? [effectiveGate] : [],
    });

    await replyRaidSetResult({
      replySetNotice,
      replySetEmbed,
      result,
      lang,
      rosterName,
      characterName,
      raidMeta,
      localizedRaid: buildLocalizedRaidLabel(raidKey, lang),
      effectiveGate,
      statusType,
      actingForOther,
      targetDiscordId,
      ownerLabel,
    });
  }

  return {
    handleRaidSetAutocomplete,
    handleRaidSetCommand,
    applyRaidSetForDiscordId,
    applyRaidSetBatchForDiscordId,
    resolveRosterOwner,
  };
}

module.exports = {
  createRaidSetCommand,
};
