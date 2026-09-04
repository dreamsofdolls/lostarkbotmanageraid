"use strict";

const {
  deferEphemeralReply,
  editEmbed,
  editNotice,
} = require("../../utils/raid/common/shared");
const {
  getAccessibleAccounts: defaultGetAccessibleAccounts,
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
    loadCachedUserForAutocomplete = loadUserForAutocomplete,
    loadCachedAccountsRegisteredBy = loadAccountsRegisteredBy,
    getAccessibleAccounts = defaultGetAccessibleAccounts,
    loadAccessibleAccountsForAutocomplete = (discordId) =>
      getAccessibleAccounts(discordId, { includeOwn: false }),
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
  const { resolveRosterOwner: resolveRosterOwnerForAutocomplete } =
    createRosterOwnerResolver({
      User,
      normalizeName,
      loadUserForAutocomplete: loadCachedUserForAutocomplete,
      loadAccountsRegisteredBy: loadCachedAccountsRegisteredBy,
      getAccessibleAccounts: loadAccessibleAccountsForAutocomplete,
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
    loadUserForAutocomplete: loadCachedUserForAutocomplete,
    loadAccessibleAccountsForAutocomplete,
    flattenRegisteredAccounts,
    resolveRosterOwner: resolveRosterOwnerForAutocomplete,
    loadAccountsRegisteredBy: loadCachedAccountsRegisteredBy,
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
    requireAnySyncEnabled = false,
    requireRaidUntouched = false,
    requiredCompanionScope = null,
    currentWeekStartMs = 0,
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
        requireAnySyncEnabled,
        requireRaidUntouched,
        requiredCompanionScope,
        currentWeekStartMs,
      });
      if (result.updated) await userDoc.save();
    });
    return result;
  }

  async function applyRaidSetBatchForDiscordId({
    discordId,
    entries,
    requireLocalSyncEnabled = false,
    requireAnySyncEnabled = false,
    requireRaidUntouched = false,
    requiredCompanionScope = null,
    currentWeekStartMs = 0,
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
          requireAnySyncEnabled,
          requireRaidUntouched,
          requiredCompanionScope,
          currentWeekStartMs,
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
    const input = readRaidSetInput(interaction);

    // Every /raid-set outcome is private, so acknowledge before the first
    // cache/DB lookup. The router can also edit this deferred reply if an
    // unexpected downstream failure occurs.
    await deferEphemeralReply(interaction);
    const ownDoc = await loadUserForAutocomplete(executorId);
    const lang = await getUserLanguage(executorId, {
      UserModel: User,
      userDoc: ownDoc,
    });
    const replySetNotice = (options, extras) =>
      editNotice(interaction, EmbedBuilder, options, extras);
    const replySetEmbed = (embed, extras) => editEmbed(interaction, embed, extras);

    const { rosterName, characterName, raidKey, statusType } = input;
    const validation = validateRaidSetInput(input, lang);
    if (!validation.valid) {
      await replySetNotice(validation.notice);
      return;
    }
    const { raidMeta, effectiveGate } = validation;

    const resolvedOwner = await resolveRosterOwner(executorId, rosterName, { ownDoc });
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
