/**
 * edit-helpers.js
 *
 * Pure helpers for the /raid-check Edit cascading select flow. Compute
 * eligible raids per char, current gate status, and label formatting -
 * everything the Edit UI needs to render and mutate before the actual
 * save fires through applyRaidSetForDiscordId.
 *
 * No closure on Discord client, Mongoose model, or async services. The
 * factory just collects the 7 string/format helpers it needs from the
 * outer compose root.
 */

function createEditHelpers({
  UI,
  normalizeName,
  toModeLabel,
  truncateText,
  getGatesForRaid,
  getGateKeys,
  getRaidScanRange,
  RAID_REQUIREMENT_MAP,
}) {

  function buildEditableCharsByUser(snapshot) {
    const byUser = new Map();
    const sourceChars = Array.isArray(snapshot.allEligible)
      ? snapshot.allEligible
      : (snapshot.allChars || []);
    for (const char of sourceChars) {
      const meta = snapshot.userMeta.get(char.discordId) || {};
      const autoSyncOn = !!meta.autoManageEnabled;
      // Auto-sync ON + log ON → bible owns, skip.
      if (autoSyncOn && !char.publicLogDisabled) continue;
      if (!byUser.has(char.discordId)) {
        byUser.set(char.discordId, {
          discordId: char.discordId,
          autoManageEnabled: autoSyncOn,
          chars: [],
        });
      }
      byUser.get(char.discordId).chars.push({
        accountName: char.accountName,
        charName: char.charName,
        itemLevel: char.itemLevel,
        publicLogDisabled: !!char.publicLogDisabled,
        autoManageEnabled: autoSyncOn,
        // Carry the normalized assignedRaids tree from the snapshot so
        // getCharRaidGateStatus + applyLocalRaidEditToChar can read + mutate
        // per-gate state without a second DB read. Without this the Edit
        // dropdown entry was a stripped shape, every gate rendered as "⚪
        // chưa clear" even for raids the char had already completed, and
        // the post-apply local mirror had nothing to mutate.
        assignedRaids: char.assignedRaids || {},
      });
    }
    // Sort chars inside each user by iLvl desc so highest-geared surfaces first.
    for (const group of byUser.values()) {
      group.chars.sort((a, b) => b.itemLevel - a.itemLevel);
    }
    return byUser;
  }

  /**
   * Raids this char is eligible for, based on the same mode range contract
   * `/raid-check` uses: a mode is editable only when
   * minItemLevel <= char iLvl < next higher mode min. Highest modes have no
   * upper bound. This keeps a 1730 char from showing Normal options that the
   * scan itself already hides as out-grown.
   */
  function getEligibleRaidsForChar(itemLevel) {
    const level = Number(itemLevel) || 0;
    return Object.entries(RAID_REQUIREMENT_MAP)
      .filter(([, entry]) => {
        const minItemLevel = Number(entry.minItemLevel) || 0;
        if (level < minItemLevel) return false;
        const { nextMin } = getRaidScanRange(entry.raidKey, minItemLevel);
        return level < nextMin;
      })
      .sort((a, b) => {
        const diff = (Number(a[1].minItemLevel) || 0) - (Number(b[1].minItemLevel) || 0);
        if (diff !== 0) return diff;
        return a[0].localeCompare(b[0]);
      })
      .map(([raidKey, entry]) => ({ raidKey, entry }));
  }

  /**
   * Read the gate state for a picked raid off the char's stored
   * assignedRaids tree. Returns per-gate rows (done? current mode?) +
   * a rollup `overallStatus` + `modeChangeNeeded` flag so the Edit UI
   * can disable buttons that would be pure no-ops and warn when the
   * picked mode would wipe a different mode's progress.
   *
   * `modeChangeNeeded` = true means the raid has at least one gate
   * stored at a DIFFERENT difficulty than the picked one. Applying
   * Complete/Process at the picked mode will wipe those gates (see
   * applyRaidSetForDiscordId's `modeResetCount` path) so the leader
   * should get a visible warning before clicking.
   */
  function getCharRaidGateStatus(character, raidKey, modeKey) {
    const assigned = character?.assignedRaids?.[raidKey] || {};
    const officialGates = getGatesForRaid(raidKey) || [];
    const normalizedPickedMode = normalizeName(toModeLabel(modeKey));
    let modeChangeNeeded = false;
    const gates = officialGates.map((gate) => {
      const entry = assigned[gate] || {};
      const storedMode = entry.difficulty
        ? String(entry.difficulty).toLowerCase()
        : null;
      const doneAtSomeMode = Number(entry.completedDate) > 0;
      const doneAtPickedMode =
        doneAtSomeMode && storedMode === normalizedPickedMode;
      if (storedMode && storedMode !== normalizedPickedMode && doneAtSomeMode) {
        modeChangeNeeded = true;
      }
      return {
        gate,
        doneAtPickedMode,
        doneAtSomeMode,
        storedMode,
      };
    });
    const doneCount = gates.filter((g) => g.doneAtPickedMode).length;
    let overallStatus;
    if (gates.length === 0) overallStatus = "unknown";
    else if (doneCount === gates.length) overallStatus = "complete";
    else if (doneCount > 0) overallStatus = "partial";
    else overallStatus = "none";
    return { gates, overallStatus, modeChangeNeeded };
  }

  function formatGateStateLine(gateStatus, raidKey) {
    if (!gateStatus || gateStatus.overallStatus === "unknown") return null;
    const parts = gateStatus.gates.map((g) => {
      if (g.doneAtPickedMode) return `🟢 ${g.gate}`;
      if (g.doneAtSomeMode) return `🟠 ${g.gate} (${g.storedMode})`;
      return `⚪ ${g.gate}`;
    });
    const rollup = gateStatus.overallStatus === "complete"
      ? "DONE"
      : gateStatus.overallStatus === "partial"
        ? "partial"
        : "chưa clear";
    return `${parts.join(" · ")}  _(${rollup})_`;
  }

  function applyLocalRaidEditToChar(character, raidMeta, statusType, effectiveGates, now = Date.now()) {
    if (!character || !raidMeta) return;
    const selectedDifficulty = toModeLabel(raidMeta.modeKey);
    const normalizedSelectedDiff = normalizeName(selectedDifficulty);
    const officialGates = getGatesForRaid(raidMeta.raidKey) || [];
    const gateList = Array.isArray(effectiveGates) ? effectiveGates.filter(Boolean) : [];
    if (!character.assignedRaids) character.assignedRaids = {};

    const raidData = character.assignedRaids[raidMeta.raidKey] || {};
    let modeChangeDetected = false;
    for (const gate of officialGates) {
      const existingDiff = raidData[gate]?.difficulty;
      if (existingDiff && normalizeName(existingDiff) !== normalizedSelectedDiff) {
        modeChangeDetected = true;
        break;
      }
    }
    if (modeChangeDetected) {
      for (const gate of officialGates) {
        raidData[gate] = { difficulty: selectedDifficulty, completedDate: undefined };
      }
    }

    const storedGateKeys = getGateKeys(raidData);
    const targetGates =
      gateList.length > 0 ? gateList :
      storedGateKeys.length > 0 ? storedGateKeys :
      officialGates;
    const shouldMarkDone = statusType === "complete" || statusType === "process";
    for (const gate of targetGates) {
      raidData[gate] = {
        difficulty: selectedDifficulty,
        completedDate: shouldMarkDone ? now : null,
      };
    }
    character.assignedRaids[raidMeta.raidKey] = raidData;
  }

  function formatCharEditLabel(char, raidMeta) {
    // Base: "Cyrano · 1733"
    const parts = [char.charName, String(Math.round(char.itemLevel))];

    // Progress hint for the raid the leader is scanning (state.raidMeta),
    // so they can see which chars still need work WITHOUT having to pick
    // each one and wait for the gate buttons to render. Uses the same
    // rollup as formatGateStateLine for visual consistency:
    //   🟢 DONE  - every gate done at the picked mode
    //   🟠 X/Y   - some gates done at the picked mode
    //   🟡 khác mode - nothing done at picked mode but char has cleared
    //                  at a different difficulty (apply would wipe it)
    //   ⚪ 0/Y   - untouched at this raid entirely
    if (raidMeta?.raidKey) {
      const gateStatus = getCharRaidGateStatus(
        char,
        raidMeta.raidKey,
        raidMeta.modeKey
      );
      const total = gateStatus.gates.length;
      if (total > 0) {
        const done = gateStatus.gates.filter((g) => g.doneAtPickedMode).length;
        if (gateStatus.overallStatus === "complete") {
          parts.push(`🟢 ${done}/${total}`);
        } else if (gateStatus.overallStatus === "partial") {
          parts.push(`🟠 ${done}/${total}`);
        } else if (gateStatus.modeChangeNeeded) {
          parts.push("🟡 khác mode");
        } else {
          parts.push(`⚪ ${done}/${total}`);
        }
      }
    }

    if (char.autoManageEnabled && char.publicLogDisabled) {
      parts.push("log off");
    }
    return truncateText(parts.join(" · "), 100);
  }

  function formatUserEditLabel(group, displayName) {
    const tag = group.autoManageEnabled ? " · auto-sync" : "";
    const count = group.chars.length;
    return truncateText(`${displayName} · ${count} editable${tag}`, 100);
  }

  return {
    buildEditableCharsByUser,
    getEligibleRaidsForChar,
    getCharRaidGateStatus,
    formatGateStateLine,
    applyLocalRaidEditToChar,
    formatCharEditLabel,
    formatUserEditLabel,
  };
}

module.exports = { createEditHelpers };
