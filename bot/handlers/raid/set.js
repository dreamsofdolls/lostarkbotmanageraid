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
const { weeklyResetStartMs } = require("../../utils/raid/schedule/reset-windows");
const {
  findCharacterInUser: findCharacterEntryInUser,
} = require("../../utils/raid/tasks/side-tasks");
const { createRaidSetApplyService } = require("./set/apply");
const { createRaidSetAutocompleteService } = require("./set/autocomplete");
const { createRaidSetInputHelpers } = require("./set/command-input");
const { createRaidSetResultResponder } = require("./set/command-result");

// Local Sync passes the week start its clears were filtered against. When a
// weekly reset has passed since then, the attempt would stamp those clears
// into the new week, so it writes nothing.
function weekMovedSince(currentWeekStartMs) {
  const floorMs = Number(currentWeekStartMs) || 0;
  return floorMs > 0 && weeklyResetStartMs() > floorMs;
}

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

  // The write sequence behind both facades: load the owner fresh, refuse a
  // missing user (noRoster) before a week that moved since the caller's
  // snapshot (outsideCurrentWeek), roll the week, apply the entries in order
  // and save once if any changed. Returns one result per entry.
  async function applyRaidSetEntries({
    discordId,
    entries,
    requireLocalSyncEnabled,
    requireRaidUntouched,
    requiredCompanionScope,
    currentWeekStartMs,
  }) {
    const refusedResults = (flag) => entries.map((entry) => ({
      ...makeRaidSetResult(entry?.raidMeta),
      [flag]: true,
    }));
    let results = [];
    await saveWithRetry(async () => {
      results = [];
      const userDoc = await User.findOne({ discordId });
      if (!userDoc) {
        results = refusedResults("noRoster");
        return;
      }
      if (weekMovedSince(currentWeekStartMs)) {
        results = refusedResults("outsideCurrentWeek");
        return;
      }

      ensureFreshWeek(userDoc);
      const now = Date.now();
      let didUpdate = false;
      for (const entry of entries) {
        const result = await applyRaidSetToLoadedUserDoc(userDoc, {
          discordId,
          executorId: entry.executorId || null,
          characterName: entry.characterName,
          rosterName: entry.rosterName || null,
          raidMeta: entry.raidMeta,
          statusType: entry.statusType || "process",
          effectiveGates: entry.effectiveGates,
          requireLocalSyncEnabled,
          requireRaidUntouched,
          requiredCompanionScope,
          currentWeekStartMs,
        }, now);
        results.push(result);
        if (result.updated) didUpdate = true;
      }

      if (didUpdate) await userDoc.save();
    });
    return results;
  }

  /**
   * Write one raid clear or reset for one character on the owner's stored
   * document, through the shared write sequence.
   * @param {object} params
   * @param {string} params.discordId - owner of the document that is written
   * @param {string|null} [params.executorId=null] - who runs the write when it
   *   is not the owner; checked against the roster's registeredBy and edit shares
   * @param {string} params.characterName
   * @param {string|null} [params.rosterName=null]
   * @param {object} params.raidMeta - raid requirement entry (raid, mode, minItemLevel)
   * @param {string} [params.statusType="process"] - "complete" and "process"
   *   mark the gates done; any other value resets them
   * @param {string[]} params.effectiveGates - gates to write; empty means every
   *   gate the character holds for the raid
   * @param {boolean} [params.requireLocalSyncEnabled=false] - refuse unless the
   *   owner has Local Sync on
   * @param {boolean} [params.requireRaidUntouched=false] - refuse when the raid
   *   already has a clear this week
   * @param {string|null} [params.requiredCompanionScope=null] - sync scope the
   *   write belongs to; the owner must have it on and the mode allowed in it
   * @param {number} [params.currentWeekStartMs=0] - week start the caller's data
   *   was filtered against; a weekly reset after it refuses the write, and clears
   *   before it do not count as progress
   * @returns {Promise<object>} the write result: `updated` is true when the
   *   document was saved, otherwise a flag says why (`noRoster`,
   *   `outsideCurrentWeek`, `authLost`, `syncDisabled`, `scopeNotAllowed`,
   *   `progressConflict`, `progressProtected`, `alreadyComplete`,
   *   `alreadyReset`, or `matched` false / `ineligibleItemLevel` for the character)
   */
  async function applyRaidSetForDiscordId({
    discordId,
    executorId = null,
    characterName,
    rosterName = null,
    raidMeta,
    statusType,
    effectiveGates,
    requireLocalSyncEnabled = false,
    requireRaidUntouched = false,
    requiredCompanionScope = null,
    currentWeekStartMs = 0,
  }) {
    const [result] = await applyRaidSetEntries({
      discordId,
      entries: [{ executorId, characterName, rosterName, raidMeta, statusType, effectiveGates }],
      requireLocalSyncEnabled,
      requireRaidUntouched,
      requiredCompanionScope,
      currentWeekStartMs,
    });
    return result;
  }

  /**
   * Write several raid clears or resets on one owner's stored document with a
   * single load and at most one save.
   * @param {object} params
   * @param {string} params.discordId - owner of the document that is written
   * @param {Array<object>} params.entries - one per write, with the per-write
   *   fields of applyRaidSetForDiscordId (`executorId`, `characterName`,
   *   `rosterName`, `raidMeta`, `statusType` defaulting to "process",
   *   `effectiveGates`); a non-array counts as empty
   * @param {boolean} [params.requireLocalSyncEnabled=false] - as in applyRaidSetForDiscordId
   * @param {boolean} [params.requireRaidUntouched=false] - as in applyRaidSetForDiscordId
   * @param {string|null} [params.requiredCompanionScope=null] - as in applyRaidSetForDiscordId
   * @param {number} [params.currentWeekStartMs=0] - as in applyRaidSetForDiscordId
   * @returns {Promise<object[]>} one result per entry, in entry order, shaped
   *   as the result of applyRaidSetForDiscordId; a missing user or a moved week
   *   gives every entry the same refusal flag
   */
  async function applyRaidSetBatchForDiscordId({
    discordId,
    entries,
    requireLocalSyncEnabled = false,
    requireRaidUntouched = false,
    requiredCompanionScope = null,
    currentWeekStartMs = 0,
  }) {
    return applyRaidSetEntries({
      discordId,
      entries: Array.isArray(entries) ? entries : [],
      requireLocalSyncEnabled,
      requireRaidUntouched,
      requiredCompanionScope,
      currentWeekStartMs,
    });
  }

  // The write is already saved, so a failed re-read must not turn the reply
  // into an error: the receipt then shows the result without the card.
  async function loadOwnerAccountsAfterWrite(discordId) {
    try {
      const ownerDoc = await User.findOne({ discordId }).lean();
      return ownerDoc.accounts.map((account) => ({ accountName: account.accountName, account }));
    } catch (err) {
      console.warn(`[raid-set] receipt re-read for ${discordId} failed:`, err?.message || err);
      return [];
    }
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
    const accounts = result.updated ? await loadOwnerAccountsAfterWrite(targetDiscordId) : [];

    await replyRaidSetResult({
      replySetNotice,
      replySetEmbed,
      result,
      accounts,
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
