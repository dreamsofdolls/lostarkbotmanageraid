"use strict";

const { RAID_REQUIREMENTS, raidModeSortRank } = require("../../../domain/raid-catalog");
const { normalizeName, toModeKey } = require("../../../utils/raid/common/shared");
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
const GOLD_RECEIVE_AUTO = "auto";
const MODE_CANCEL = "cancel";

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
  const plain = toPlainAssignedRaid(target.assignedRaids[raidKey]);
  delete plain.goldDisabled;
  delete plain.goldForced;
  if (overrideValue) plain.goldOverride = overrideValue;
  else delete plain.goldOverride;
  target.assignedRaids[raidKey] = plain;
}

/**
 * Parse the multi-select difficulty values (`raidKey::modeKey` or
 * `raidKey::cancel`) into one decision per raid. Several modes of one raid
 * keep the highest-ranked one; a cancel applies only when no mode of that raid
 * was picked.
 * @param {string[]} values - submitted select values
 * @returns {{decisions: Map<string, {modeKey: string}|{cancel: true}>, collapsed: Array<{raidKey: string, keptModeKey: string, droppedModeKeys: string[]}>, invalid: boolean}}
 *   invalid (with no decisions) when any value is malformed or unknown
 */
function parseGoldModeValues(values) {
  const rejected = { decisions: new Map(), collapsed: [], invalid: true };
  const picks = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const parts = String(value).split("::");
    if (parts.length !== 2) return rejected;
    const [raidKey, modeKey] = parts;
    const isCancel = modeKey === MODE_CANCEL;
    if (!VALID_RAID_KEYS.has(raidKey)) return rejected;
    if (!isCancel && !RAID_REQUIREMENTS[raidKey].modes?.[modeKey]) return rejected;
    const pick = picks.get(raidKey) || { modeKeys: [], cancel: false };
    if (isCancel) pick.cancel = true;
    else if (!pick.modeKeys.includes(modeKey)) pick.modeKeys.push(modeKey);
    picks.set(raidKey, pick);
  }
  if (picks.size === 0) return rejected;

  const decisions = new Map();
  const collapsed = [];
  for (const [raidKey, pick] of picks) {
    if (pick.modeKeys.length === 0) {
      decisions.set(raidKey, { cancel: true });
      continue;
    }
    const ranked = [...pick.modeKeys]
      .sort((a, b) => raidModeSortRank(raidKey, b) - raidModeSortRank(raidKey, a));
    decisions.set(raidKey, { modeKey: ranked[0] });
    if (ranked.length > 1) {
      collapsed.push({ raidKey, keptModeKey: ranked[0], droppedModeKeys: ranked.slice(1) });
    }
  }
  return { decisions, collapsed, invalid: false };
}

/**
 * Apply one raid decision to a character, mutating its assigned raid. A raid
 * with no clears this week changes at once; one with clears queues the change
 * for the next reset; picking the current mode while a change is queued
 * cancels it.
 * @param {object} character - character document or plain object
 * @param {string} raidKey - catalog raid key
 * @param {{modeKey: string}|{cancel: true}} decision - from parseGoldModeValues
 * @returns {"immediate"|"deferred"|"cancelled"|"noop"|"ineligible"} outcome
 */
function applyModeDecision(character, raidKey, decision) {
  if (!character.assignedRaids) character.assignedRaids = {};
  const raidData = character.assignedRaids[raidKey] || {};
  const plain = toPlainAssignedRaid(raidData);
  const writePlain = (outcome) => {
    character.assignedRaids[raidKey] = plain;
    return outcome;
  };
  const cancelPending = () => {
    if (!plain.pendingModeKey) return "noop";
    delete plain.pendingModeKey;
    return writePlain("cancelled");
  };

  if (decision?.cancel) return cancelPending();

  const modeKey = decision?.modeKey;
  const requirement = getRequirementFor(raidKey, modeKey);
  if (!requirement || (Number(character.itemLevel) || 0) < requirement.minItemLevel) {
    return "ineligible";
  }

  const currentMode = getRaidModeKey(raidKey, raidData, character);
  if (getCompletedGateKeys(raidData).length === 0) {
    if (modeKey === currentMode && !plain.pendingModeKey) return "noop";
    character.assignedRaids[raidKey] = setAssignedRaidMode(plain, raidKey, modeKey);
    return "immediate";
  }
  if (modeKey === currentMode) return cancelPending();
  if (plain.pendingModeKey === modeKey) return "noop";
  plain.pendingModeKey = modeKey;
  return writePlain("deferred");
}

/**
 * Parse the gold-set select values: raid keys (at most the per-character cap)
 * or the auto option, which wins over any raid ticked with it.
 * @param {string[]} values - submitted select values
 * @returns {{kind: "auto"}|{kind: "set", raidKeys: string[]}|{kind: "invalid"}}
 */
function parseGoldReceiveValues(values) {
  const list = Array.isArray(values) ? values.map(String) : [];
  if (list.includes(GOLD_RECEIVE_AUTO)) return { kind: "auto" };
  const raidKeys = [...new Set(list)];
  const valid = raidKeys.length > 0
    && raidKeys.length <= GOLD_RAID_CAP_PER_CHARACTER
    && raidKeys.every((raidKey) => VALID_RAID_KEYS.has(raidKey));
  return valid ? { kind: "set", raidKeys } : { kind: "invalid" };
}

function receivingRaidKeys(character) {
  return getStatusRaidsForCharacter(character)
    .filter((raid) => raid.goldReceives)
    .map((raid) => raid.raidKey);
}

/**
 * Apply a gold set to a character. A set includes the ticked raids and
 * excludes every other raid the character's card shows; auto removes every
 * override. Raids are written only when their override actually changes.
 * @param {object} character - character document or plain object
 * @param {{kind: "auto"}|{kind: "set", raidKeys: string[]}} receive - from parseGoldReceiveValues
 * @returns {{changed: boolean, before: string[], after: string[], skipped: string[]}}
 *   receiving raid keys before/after, and ticked raids the character lacks
 */
function applyGoldReceive(character, receive) {
  if (!character.assignedRaids) character.assignedRaids = {};
  const statusRaids = getStatusRaidsForCharacter(character);
  const before = statusRaids.filter((raid) => raid.goldReceives).map((raid) => raid.raidKey);
  const statusKeys = new Set(statusRaids.map((raid) => raid.raidKey));
  const isAuto = receive?.kind === GOLD_RECEIVE_AUTO;
  const ticked = new Set(isAuto ? [] : receive?.raidKeys || []);

  // Catalog keys rather than Object.keys: a Mongoose subdoc exposes internals.
  const targets = isAuto
    ? [...VALID_RAID_KEYS]
      .filter((raidKey) => character.assignedRaids[raidKey])
      .map((raidKey) => [raidKey, null])
    : statusRaids.map((raid) => [raid.raidKey, ticked.has(raid.raidKey) ? "include" : "exclude"]);

  let changed = false;
  for (const [raidKey, override] of targets) {
    if (getGoldOverride(character.assignedRaids[raidKey]) === override) continue;
    writeAssignedRaidOverride(character, raidKey, override);
    changed = true;
  }

  return {
    changed,
    before,
    after: receivingRaidKeys(character),
    skipped: [...ticked].filter((raidKey) => !statusKeys.has(raidKey)),
  };
}

function findAccountCharacter(account, targetCharName) {
  const charName = normalizeName(targetCharName);
  const character = (Array.isArray(account?.characters) ? account.characters : []).find(
    (c) => normalizeName(c?.name || c?.charName) === charName
  );
  if (!character) return null;
  if (!character.assignedRaids) character.assignedRaids = {};
  return character;
}

function markAccountsModified(userDocFresh) {
  userDocFresh?.markModified("accounts");
}

async function updateGoldWriteTargets(options, applyUpdate) {
  const {
    User,
    saveWithRetry,
    discordId,
    targetAccountName,
    targetCharNames = [],
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
    const account = userDocFresh
      ? findAccountByName(userDocFresh, targetAccountName, normalizeName)
      : null;
    const entries = targetCharNames.map((name) => ({
      name,
      character: account ? findAccountCharacter(account, name) : null,
    }));

    // A roster renamed or removed since the card was drawn still reaches the
    // writer, with every entry missing, so the caller can name them.
    const shouldSave = await applyUpdate({ userDoc: userDocFresh, account, entries });
    if (!shouldSave && !saveRollover) return;

    markAccountsModified(userDocFresh);
    await userDocFresh.save();
    saved = true;
    savedUserDoc = userDocFresh;
  });

  return { saved, userDoc: savedUserDoc, denied };
}

const CHANGED_MODE_OUTCOMES = new Set(["immediate", "deferred", "cancelled"]);

function characterClassName(character) {
  return String(character.class || character.className || "");
}

/**
 * Apply raid decisions to every named character of one account in a single
 * save. Outcomes are rebuilt on every attempt, so they describe the attempt
 * that saved.
 * @param {object} options - User, saveWithRetry, discordId (roster owner),
 *   targetAccountName, targetCharNames, decisions (from parseGoldModeValues),
 *   and optionally canWrite (asked before every save attempt)
 * @returns {Promise<{ok: boolean, denied: boolean, results: Array<{name: string, className: string, missing: boolean, itemLevel: number, outcomes: Array<{raidKey: string, modeKey: string|null, outcome: string, minItemLevel: number}>}>, userDoc: object|null}>}
 *   ok is true when the document was saved
 */
async function saveBulkRaidModes(options) {
  const decisions = options.decisions instanceof Map ? options.decisions : new Map();
  let results = [];
  const update = await updateGoldWriteTargets(
    { ...options, saveRolloverAlone: true },
    ({ entries }) => {
      results = entries.map(({ name, character }) => {
        if (!character) return { name, className: "", missing: true, itemLevel: 0, outcomes: [] };
        const outcomes = [...decisions].map(([raidKey, decision]) => ({
          raidKey,
          modeKey: decision.modeKey || null,
          outcome: applyModeDecision(character, raidKey, decision),
          minItemLevel: getRequirementFor(raidKey, decision.modeKey)?.minItemLevel || 0,
        }));
        return {
          name: character.name || name,
          className: characterClassName(character),
          missing: false,
          itemLevel: Number(character.itemLevel) || 0,
          outcomes,
        };
      });
      return results.some((entry) => entry.outcomes.some(
        (item) => CHANGED_MODE_OUTCOMES.has(item.outcome)
      ));
    }
  );
  return { ok: update.saved, denied: update.denied, results, userDoc: update.userDoc };
}

function goldReceiveStatus(applied, added, removed) {
  if (!applied.changed) return "unchanged";
  return added.length > 0 || removed.length > 0 ? "changed" : "pinned";
}

/**
 * Apply one gold set (or auto) to every named character of one account in a
 * single save.
 * @param {object} options - User, saveWithRetry, discordId (roster owner),
 *   targetAccountName, targetCharNames, receive (from parseGoldReceiveValues),
 *   and optionally canWrite (asked before every save attempt)
 * @returns {Promise<{ok: boolean, denied: boolean, results: Array<{name: string, className: string, status: "changed"|"pinned"|"unchanged"|"missing", added: string[], removed: string[], kept: string[], skipped: string[]}>, userDoc: object|null}>}
 *   pinned = overrides changed while the receiving raids stayed the same
 */
async function saveBulkGoldReceive(options) {
  const { receive } = options;
  let results = [];
  const update = await updateGoldWriteTargets(options, ({ entries }) => {
    results = entries.map(({ name, character }) => {
      if (!character) {
        return { name, className: "", status: "missing", added: [], removed: [], kept: [], skipped: [] };
      }
      const applied = applyGoldReceive(character, receive);
      const added = applied.after.filter((raidKey) => !applied.before.includes(raidKey));
      const removed = applied.before.filter((raidKey) => !applied.after.includes(raidKey));
      return {
        name: character.name || name,
        className: characterClassName(character),
        status: goldReceiveStatus(applied, added, removed),
        added,
        removed,
        kept: applied.after,
        skipped: applied.skipped,
      };
    });
    return results.some((entry) => entry.status === "changed" || entry.status === "pinned");
  });
  return { ok: update.saved, denied: update.denied, results, userDoc: update.userDoc };
}

module.exports = {
  GOLD_RECEIVE_AUTO,
  MODE_CANCEL,
  applyGoldReceive,
  applyModeDecision,
  parseGoldModeValues,
  parseGoldReceiveValues,
  saveBulkGoldReceive,
  saveBulkRaidModes,
};

function getRaidModeKey(raidKey, raidData, character) {
  const assignedModeKey = getAssignedRaidModeKey(raidData, raidKey);
  if (assignedModeKey) return assignedModeKey;

  const gateDifficulty = raidData?.G1?.difficulty || raidData?.G2?.difficulty || "";
  const gateModeKey = gateDifficulty ? toModeKey(gateDifficulty) : null;
  if (RAID_REQUIREMENTS[raidKey]?.modes?.[gateModeKey]) return gateModeKey;

  return getBestEligibleModeKey(raidKey, Number(character?.itemLevel) || 0) || "normal";
}
