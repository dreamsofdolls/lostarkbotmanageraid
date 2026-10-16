"use strict";

const { RAID_REQUIREMENTS, isGoldBound } = require("../../../domain/raid-catalog");
const { normalizeName, toModeKey, toModeLabel } = require("../../../utils/raid/common/shared");
const {
  getAssignedRaidModeKey,
  getBestEligibleModeKey,
  getCompletedGateKeys,
  getRequirementFor,
  setAssignedRaidMode,
  toPlainAssignedRaid,
} = require("../../../utils/raid/common/character/assigned-raids");
const { ensureFreshWeek } = require("../../../services/raid/schedulers/weekly-reset");
const { findAccountByName } = require("../../../utils/user-doc");
const {
  GOLD_RAID_CAP_PER_CHARACTER,
  getGoldOverride,
  getStatusRaidsForCharacter,
} = require("../../../utils/raid/common/character");

const VALID_RAID_KEYS = new Set(Object.keys(RAID_REQUIREMENTS));

// Persist a gold override onto a single assigned-raid entry. assignedRaids
// subdocs use a strict:false Mongoose subschema, and `goldOverride` is a
// dynamic (non-schema) field. Assigning it straight onto the live subdoc
// (`subdoc.goldOverride = x`) bypasses Mongoose's setter: the value lands on
// the wrapper object, never reaches the document's _doc, and is silently
// dropped on serialize - so the save no-ops and the override never sticks
// (verified: toObject() omits the field). Rebuilding the entry as a plain
// object and re-assigning it forces Mongoose to re-cast a fresh subdoc that
// carries the field through to the DB.
function writeAssignedRaidOverride(target, raidKey, overrideValue) {
  if (!target.assignedRaids) target.assignedRaids = {};
  const current = target.assignedRaids[raidKey];
  const plain = current ? current.toObject() : {};
  delete plain.goldDisabled;
  delete plain.goldForced;
  if (overrideValue) plain.goldOverride = overrideValue;
  else delete plain.goldOverride;
  target.assignedRaids[raidKey] = plain;
}

function parseGoldToggleValue(value) {
  if (!value || value === "noop") return { kind: "noop" };
  const sepIdx = String(value).indexOf("::");
  const targetCharName = sepIdx > 0 ? String(value).slice(0, sepIdx) : "";
  const raidKey = sepIdx > 0 ? String(value).slice(sepIdx + 2) : "";
  if (!targetCharName || !VALID_RAID_KEYS.has(raidKey)) return { kind: "invalid" };
  return {
    kind: "single",
    targetCharName,
    raidKey,
  };
}

function parseGoldModeValue(value) {
  if (!value || value === "noop") return { kind: "noop" };
  const parts = String(value).split("::");
  if (parts.length < 3) return { kind: "invalid" };
  const modeKey = parts.pop();
  const raidKey = parts.pop();
  const targetCharName = parts.join("::");
  if (
    !targetCharName ||
    !VALID_RAID_KEYS.has(raidKey) ||
    !RAID_REQUIREMENTS[raidKey]?.modes?.[modeKey]
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "single",
    targetCharName,
    raidKey,
    modeKey,
  };
}

function findGoldWriteTarget(userDocFresh, targetAccountName, targetCharName) {
  const charName = normalizeName(targetCharName);
  const account = findAccountByName(userDocFresh, targetAccountName, normalizeName);
  if (!account || !Array.isArray(account.characters)) return null;

  const character = account.characters.find(
    (c) => normalizeName(c?.name || c?.charName) === charName
  );
  if (!character) return null;
  if (!character.assignedRaids) character.assignedRaids = {};
  return { account, character };
}

function markAccountsModified(userDocFresh) {
  userDocFresh?.markModified("accounts");
}

async function updateGoldWriteTarget(options, applyUpdate) {
  const {
    User,
    saveWithRetry,
    discordId,
    targetAccountName,
    targetCharName,
    canWrite = null,
    saveRolloverAlone = false,
  } = options;

  let saved = false;
  let savedUserDoc = null;
  let denied = false;
  await saveWithRetry(async () => {
    // Asked on every attempt: a retry follows another write, which can be
    // the owner revoking the share this write relied on.
    if (canWrite && !(await canWrite())) {
      denied = true;
      return;
    }
    const userDocFresh = await User.findOne({ discordId });
    // Roll a user the weekly reset job has not reached yet into this week
    // before deciding; a choice written onto last week's cursor is cleared
    // as old data at the next rollover. The rollover is saved with the
    // change, or on its own only when the caller asks for it.
    const didFreshenWeek = userDocFresh ? ensureFreshWeek(userDocFresh) : false;
    const saveRollover = didFreshenWeek && saveRolloverAlone;
    const target = findGoldWriteTarget(userDocFresh, targetAccountName, targetCharName);
    if (!target) {
      if (saveRollover) {
        markAccountsModified(userDocFresh);
        await userDocFresh.save();
        saved = true;
        savedUserDoc = userDocFresh;
      }
      return;
    }

    const shouldSave = await applyUpdate({
      userDoc: userDocFresh,
      account: target.account,
      character: target.character,
    });
    if (!shouldSave && !saveRollover) return;

    markAccountsModified(userDocFresh);
    await userDocFresh.save();
    saved = true;
    savedUserDoc = userDocFresh;
  });

  return { saved, userDoc: savedUserDoc, denied };
}

/**
 * Cycle one raid's gold override on the owner's fresh document, rolled into
 * the current week first.
 * @param {object} options - User, saveWithRetry, discordId (roster owner),
 *   targetAccountName, targetCharName, raidKey, and optionally canWrite
 *   (asked before every save attempt)
 * @returns {Promise<{ok: boolean, denied: boolean, override: string|null, disabled: boolean, needsReplacement: boolean, replacement: object|null, targetRaid: object|null}>}
 *   ok is false when nothing was saved; denied is true when canWrite refused
 */
async function toggleRaidGoldDisabled(options) {
  const {
    raidKey,
  } = options;

  let nextOverride = null;
  let targetRaid = null;
  let replacement = null;
  const update = await updateGoldWriteTarget(options, ({ character: target }) => {
    const raidData = target.assignedRaids[raidKey] || {};
    nextOverride = getNextGoldOverride(raidKey, raidData, target);
    const raids = getStatusRaidsForCharacter(target);
    targetRaid = summarizeGoldRaidEntry(raids.find((raid) => raid.raidKey === raidKey));
    replacement = getGoldReplacementRequirement(target, raidKey, nextOverride, raids);
    if (replacement?.required) return false;

    writeAssignedRaidOverride(target, raidKey, nextOverride);
    return true;
  });
  return {
    ok: update.saved,
    denied: update.denied,
    override: nextOverride,
    disabled: nextOverride === "exclude",
    needsReplacement: !!replacement?.required,
    replacement,
    targetRaid,
  };
}

/**
 * Include one raid and exclude another in a single save, on the owner's
 * fresh document rolled into the current week.
 * @param {object} options - User, saveWithRetry, discordId (roster owner),
 *   targetAccountName, targetCharName, includeRaidKey, excludeRaidKey, and
 *   optionally canWrite (asked before every save attempt)
 * @returns {Promise<{ok: boolean, userDoc?: object|null, denied?: boolean}>}
 *   ok is false when nothing was saved; denied is true when canWrite refused
 */
async function replaceRaidGoldSelection(options) {
  const {
    includeRaidKey,
    excludeRaidKey,
  } = options;

  if (!VALID_RAID_KEYS.has(includeRaidKey) || !VALID_RAID_KEYS.has(excludeRaidKey)) {
    return { ok: false };
  }

  const update = await updateGoldWriteTarget(options, ({ character: target }) => {
    writeAssignedRaidOverride(target, includeRaidKey, "include");
    writeAssignedRaidOverride(target, excludeRaidKey, "exclude");
    return true;
  });

  return { ok: update.saved, userDoc: update.userDoc, denied: update.denied };
}

/**
 * Run toggleRaidGoldDisabled for a parsed dropdown value, turning a thrown
 * save error into ok false.
 * @param {object} options - toggleRaidGoldDisabled's options with parsed
 *   (from parseGoldToggleValue) in place of targetCharName/raidKey
 * @returns {Promise<object>} handled plus toggleRaidGoldDisabled's result
 */
async function toggleParsedGoldRaid(options) {
  const { parsed, logger = console } = options;
  if (parsed?.kind !== "single") return { handled: false, ok: false };
  try {
    const result = await toggleRaidGoldDisabled({
      ...options,
      targetCharName: parsed.targetCharName,
      raidKey: parsed.raidKey,
    });
    return { handled: true, ...result };
  } catch (err) {
    logger.error?.("[raid-status gold toggle] save failed:", err?.message || err);
    return { handled: true, ok: false, error: err };
  }
}

/**
 * Set or defer a raid's mode on the owner's fresh document. This is the one
 * gold write that also saves a week rollover on its own.
 * @param {object} options - User, saveWithRetry, discordId (roster owner),
 *   targetAccountName, targetCharName, raidKey, modeKey, and optionally
 *   canWrite (asked before every save attempt)
 * @returns {Promise<{ok: boolean, outcome: string, raidKey: string, modeKey: string, raidLabel: string, modeLabel: string, userDoc?: object|null}>}
 *   outcome is immediate, deferred, cancelled, noop, ineligible, invalid or denied
 */
async function setParsedGoldRaidMode(options) {
  const {
    raidKey,
    modeKey,
  } = options;
  const modeMeta = RAID_REQUIREMENTS[raidKey]?.modes?.[modeKey];
  const requirement = getRequirementFor(raidKey, modeKey);
  const raidLabel = RAID_REQUIREMENTS[raidKey]?.label || raidKey;
  const modeLabel = modeMeta?.label || toModeLabel(modeKey);
  if (!VALID_RAID_KEYS.has(raidKey) || !modeMeta || !requirement) {
    return { ok: false, outcome: "invalid", raidKey, modeKey, raidLabel, modeLabel };
  }

  let outcome = "noop";
  let touchedTarget = false;
  const update = await updateGoldWriteTarget(
    { ...options, saveRolloverAlone: true },
    ({ character: target }) => {
      touchedTarget = true;
      const itemLevel = Number(target?.itemLevel) || 0;
      if (itemLevel < requirement.minItemLevel) {
        outcome = "ineligible";
        return false;
      }

      const raidData = target.assignedRaids[raidKey] || {};
      const currentMode = getRaidModeKey(raidKey, raidData, target);
      const hasRun = getCompletedGateKeys(raidData).length > 0;
      const plain = toPlainAssignedRaid(raidData);

      if (!hasRun) {
        if (modeKey === currentMode && !plain.pendingModeKey) {
          outcome = "noop";
          return false;
        }
        target.assignedRaids[raidKey] = setAssignedRaidMode(plain, raidKey, modeKey);
        outcome = "immediate";
      } else if (modeKey === currentMode) {
        if (!plain.pendingModeKey) {
          outcome = "noop";
          return false;
        }
        delete plain.pendingModeKey;
        target.assignedRaids[raidKey] = plain;
        outcome = "cancelled";
      } else {
        plain.pendingModeKey = modeKey;
        target.assignedRaids[raidKey] = plain;
        outcome = "deferred";
      }

      return true;
    }
  );

  if (update.denied) outcome = "denied";
  const ok = touchedTarget
    && update.saved
    && outcome !== "ineligible"
    && outcome !== "invalid"
    && outcome !== "noop";
  return { ok, outcome, raidKey, modeKey, raidLabel, modeLabel, userDoc: update.userDoc };
}

module.exports = {
  parseGoldModeValue,
  parseGoldToggleValue,
  setParsedGoldRaidMode,
  toggleParsedGoldRaid,
  toggleRaidGoldDisabled,
  replaceRaidGoldSelection,
  getNextGoldOverride,
};

function getRaidModeKey(raidKey, raidData, character) {
  const assignedModeKey = getAssignedRaidModeKey(raidData, raidKey);
  if (assignedModeKey) return assignedModeKey;

  const gateDifficulty = raidData?.G1?.difficulty || raidData?.G2?.difficulty || "";
  const gateModeKey = gateDifficulty ? toModeKey(gateDifficulty) : null;
  if (RAID_REQUIREMENTS[raidKey]?.modes?.[gateModeKey]) return gateModeKey;

  return getBestEligibleModeKey(raidKey, Number(character?.itemLevel) || 0) || "normal";
}

function getNextGoldOverride(raidKey, raidData, character) {
  const current = getGoldOverride(raidData);
  if (current === "include") return "exclude";
  if (current === "exclude") return null;

  const modeKey = getRaidModeKey(raidKey, raidData, character);
  return isGoldBound(raidKey, modeKey) ? "include" : "exclude";
}

function summarizeGoldRaidEntry(raid) {
  if (!raid) return null;
  return {
    raidKey: raid.raidKey,
    modeKey: raid.modeKey,
    raidName: raid.raidName,
    rawTotalGold: raid.rawTotalGold,
    totalGold: raid.totalGold,
    goldBound: raid.goldBound,
    goldSlotRank: raid.goldSlotRank,
  };
}

function getGoldReplacementRequirement(character, raidKey, nextOverride, raidEntries) {
  if (nextOverride !== "include") return { required: false };
  const raids = Array.isArray(raidEntries) ? raidEntries : getStatusRaidsForCharacter(character);
  const targetRaid = raids.find((raid) => raid.raidKey === raidKey);
  if (!targetRaid || targetRaid.goldReceives) return { required: false };

  const receivingRaids = raids.filter((raid) => raid.goldReceives);
  if (receivingRaids.length < GOLD_RAID_CAP_PER_CHARACTER) {
    return { required: false };
  }

  return {
    required: true,
    cap: GOLD_RAID_CAP_PER_CHARACTER,
    targetCharName: character?.name || character?.charName || "",
    targetRaid: summarizeGoldRaidEntry(targetRaid),
    options: receivingRaids.map(summarizeGoldRaidEntry),
  };
}
