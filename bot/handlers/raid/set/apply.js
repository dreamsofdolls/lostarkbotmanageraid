"use strict";

const {
  COMPANION_SCOPE,
  isCompanionScopeEnabledForUser,
  isModeAllowedForCompanionScope,
  resolveRequiredCompanionScope,
} = require("../../../services/local-sync/core/scope");

function createRaidSetApplyService({
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
}) {
  function makeRaidSetResult(raidMeta) {
    return {
      noRoster: false,
      authLost: false,
      syncDisabled: false,
      syncDisabledReason: null,
      scopeNotAllowed: false,
      progressConflict: false,
      matched: false,
      updated: false,
      alreadyComplete: false,
      alreadyReset: false,
      ineligibleItemLevel: 0,
      modeResetCount: 0,
      selectedDifficulty: toModeLabel(raidMeta?.modeKey),
      displayName: "",
    };
  }

  async function rejectUnauthorizedHelperWrite(result, userDoc, {
    discordId,
    executorId,
    rosterName,
  }) {
    if (!executorId || executorId === discordId) return false;

    const rosterTarget = rosterName ? normalizeName(rosterName) : "";
    const account = userDoc.accounts.find(
      (item) => normalizeName(item.accountName) === rosterTarget
    );
    if (!account) {
      result.authLost = true;
      return true;
    }

    const isHelperManager = account.registeredBy === executorId;
    const isShareEdit = !isHelperManager
      && (await canEditAccount(executorId, discordId));
    if (!isHelperManager && !isShareEdit) {
      result.authLost = true;
      return true;
    }
    return false;
  }

  function detectModeChange(
    raidData,
    raidMeta,
    selectedDifficulty,
    currentWeekStartMs = 0
  ) {
    const normalizedSelectedDiff = normalizeName(selectedDifficulty);
    const officialGateList = getGatesForRaid(raidMeta.raidKey);
    let changed = Boolean(raidData.modeKey && raidData.modeKey !== raidMeta.modeKey);

    for (const gate of officialGateList) {
      const existingDiff = raidData[gate]?.difficulty;
      if (existingDiff && normalizeName(existingDiff) !== normalizedSelectedDiff) {
        changed = true;
      }
    }

    const progressFloorMs = Math.max(0, Number(currentWeekStartMs) || 0);
    const hadProgress = changed && officialGateList.some((gate) => {
      const completedAt = Number(raidData[gate]?.completedDate);
      return completedAt > 0 && completedAt >= progressFloorMs;
    });

    return { changed, hadProgress, officialGateList };
  }

  function resetRaidMode(raidData, gates, selectedDifficulty) {
    for (const gate of gates) {
      raidData[gate] = { difficulty: selectedDifficulty, completedDate: undefined };
    }
  }

  function everyTargetAlreadyDone(
    raidData,
    gateKeys,
    selectedDifficulty,
    currentWeekStartMs = 0
  ) {
    const normalizedSelectedDiff = normalizeName(selectedDifficulty);
    const progressFloorMs = Math.max(0, Number(currentWeekStartMs) || 0);
    return gateKeys.length > 0 && gateKeys.every((gate) => {
      const entry = raidData[gate];
      if (!entry) return false;
      const completedAt = Number(entry.completedDate);
      if (!(completedAt > 0) || completedAt < progressFloorMs) return false;
      const entryDiff = normalizeName(entry.difficulty || "");
      return !entryDiff || entryDiff === normalizedSelectedDiff;
    });
  }

  function everyTargetAlreadyEmpty(raidData, gateKeys) {
    return gateKeys.length === 0 || gateKeys.every((gate) => {
      const entry = raidData[gate];
      return !entry || !(Number(entry.completedDate) > 0);
    });
  }

  function applyGateUpdates(raidData, gateKeys, { shouldMarkDone, selectedDifficulty, now }) {
    for (const gate of gateKeys) {
      const existingEntry = raidData[gate] || {};
      raidData[gate] = {
        difficulty: shouldMarkDone
          ? selectedDifficulty
          : (existingEntry.difficulty || selectedDifficulty),
        completedDate: shouldMarkDone ? now : null,
      };
    }
  }

  async function applyRaidSetToLoadedUserDoc(userDoc, {
    discordId,
    executorId = null,
    characterName,
    rosterName = null,
    raidMeta,
    statusType,
    effectiveGates,
    requireLocalSyncEnabled = false,
    requiredCompanionScope = null,
    currentWeekStartMs = 0,
  }, now = Date.now()) {
    const result = makeRaidSetResult(raidMeta);
    const gateList = Array.isArray(effectiveGates) ? effectiveGates.filter(Boolean) : [];
    const selectedDifficulty = result.selectedDifficulty;

    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      result.noRoster = true;
      return result;
    }
    const companionScope = resolveRequiredCompanionScope({
      requiredCompanionScope,
      requireLocalSyncEnabled,
    });
    if (requiredCompanionScope && !companionScope) {
      result.scopeNotAllowed = true;
      return result;
    }
    if (companionScope && !isCompanionScopeEnabledForUser(userDoc, companionScope)) {
      result.syncDisabled = true;
      result.syncDisabledReason = companionScope === COMPANION_SCOPE.solo
        ? "auto_sync_disabled"
        : "local_sync_disabled";
      return result;
    }
    if (companionScope && !isModeAllowedForCompanionScope(companionScope, raidMeta?.modeKey)) {
      result.scopeNotAllowed = true;
      return result;
    }
    if (await rejectUnauthorizedHelperWrite(result, userDoc, { discordId, executorId, rosterName })) {
      return result;
    }

    const character = findCharacterInUser(userDoc, characterName, rosterName);
    if (!character) return result;
    result.matched = true;
    result.displayName = getCharacterName(character);

    const charItemLevel = Number(character.itemLevel) || 0;
    if (charItemLevel < raidMeta.minItemLevel) {
      result.ineligibleItemLevel = charItemLevel;
      return result;
    }

    const assignedRaids = ensureAssignedRaids(character);
    const raidData = normalizeAssignedRaid(
      assignedRaids[raidMeta.raidKey] || {},
      selectedDifficulty,
      raidMeta.raidKey
    );
    const shouldMarkDone = statusType === "complete" || statusType === "process";
    const { changed: modeChangeDetected, hadProgress, officialGateList } = shouldMarkDone
      ? detectModeChange(
        raidData,
        raidMeta,
        selectedDifficulty,
        currentWeekStartMs
      )
      : { changed: false, hadProgress: false, officialGateList: getGatesForRaid(raidMeta.raidKey) };

    if (
      companionScope === COMPANION_SCOPE.solo
      && modeChangeDetected
      && hadProgress
    ) {
      result.progressConflict = true;
      return result;
    }

    if (modeChangeDetected) {
      resetRaidMode(raidData, officialGateList, selectedDifficulty);
      result.modeResetCount = hadProgress ? 1 : 0;
    }
    if (shouldMarkDone) raidData.modeKey = raidMeta.modeKey;

    const gateKeys = gateList.length > 0 ? gateList : getGateKeys(raidData);
    if (
      shouldMarkDone
      && !modeChangeDetected
      && everyTargetAlreadyDone(
        raidData,
        gateKeys,
        selectedDifficulty,
        currentWeekStartMs
      )
    ) {
      result.alreadyComplete = true;
      return result;
    }
    if (!shouldMarkDone && !modeChangeDetected && everyTargetAlreadyEmpty(raidData, gateKeys)) {
      result.alreadyReset = true;
      return result;
    }

    applyGateUpdates(raidData, gateKeys, { shouldMarkDone, selectedDifficulty, now });
    if (shouldMarkDone) raidData.modeKey = raidMeta.modeKey;
    assignedRaids[raidMeta.raidKey] = raidData;
    character.assignedRaids = assignedRaids;
    if (!character.name) character.name = getCharacterName(character);
    if (!character.class) character.class = getCharacterClass(character);
    if (!character.id) character.id = createCharacterId();
    result.updated = true;
    return result;
  }

  return {
    makeRaidSetResult,
    applyRaidSetToLoadedUserDoc,
  };
}

module.exports = {
  createRaidSetApplyService,
};
