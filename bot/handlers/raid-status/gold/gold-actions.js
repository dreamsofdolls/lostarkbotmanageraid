"use strict";

const { RAID_REQUIREMENTS, isGoldBound } = require("../../../models/Raid");
const { normalizeName, toModeKey } = require("../../../utils/raid/common/shared");
const {
  getAssignedRaidModeKey,
  getBestEligibleModeKey,
} = require("../../../utils/raid/common/character/assigned-raids");
const {
  GOLD_RAID_CAP_PER_CHARACTER,
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
// carries the field through to the DB. Plain-object callers (unit-test mocks)
// have no toObject(); the spread fallback handles them.
function writeAssignedRaidOverride(target, raidKey, overrideValue) {
  if (!target.assignedRaids) target.assignedRaids = {};
  const current = target.assignedRaids[raidKey];
  const plain = current && typeof current.toObject === "function"
    ? current.toObject()
    : { ...(current || {}) };
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

async function toggleRaidGoldDisabled(options) {
  const {
    User,
    saveWithRetry,
    discordId,
    targetAccountName,
    targetCharName,
    raidKey,
  } = options;

  let nextOverride = null;
  let targetRaid = null;
  let saved = false;
  let replacement = null;
  await saveWithRetry(async () => {
    const userDocFresh = await User.findOne({ discordId });
    if (!userDocFresh || !Array.isArray(userDocFresh.accounts)) return;
    const account = userDocFresh.accounts.find(
      (a) => normalizeName(a?.accountName) === normalizeName(targetAccountName)
    );
    if (!account || !Array.isArray(account.characters)) return;

    const target = account.characters.find(
      (c) => normalizeName(c?.name || c?.charName) === normalizeName(targetCharName)
    );
    if (!target) return;
    if (!target.assignedRaids) target.assignedRaids = {};
    const raidData = target.assignedRaids[raidKey] || {};
    nextOverride = getNextGoldOverride(raidKey, raidData, target);
    const raids = getStatusRaidsForCharacter(target);
    targetRaid = summarizeGoldRaidEntry(raids.find((raid) => raid.raidKey === raidKey));
    replacement = getGoldReplacementRequirement(target, raidKey, nextOverride, raids);
    if (replacement?.required) return;

    writeAssignedRaidOverride(target, raidKey, nextOverride);
    if (typeof userDocFresh.markModified === "function") {
      userDocFresh.markModified("accounts");
    }
    await userDocFresh.save();
    saved = true;
  });
  return {
    ok: saved,
    override: nextOverride,
    disabled: nextOverride === "exclude",
    needsReplacement: !!replacement?.required,
    replacement,
    targetRaid,
  };
}

async function replaceRaidGoldSelection(options) {
  const {
    User,
    saveWithRetry,
    discordId,
    targetAccountName,
    targetCharName,
    includeRaidKey,
    excludeRaidKey,
  } = options;

  if (!VALID_RAID_KEYS.has(includeRaidKey) || !VALID_RAID_KEYS.has(excludeRaidKey)) {
    return { ok: false };
  }

  let saved = false;
  let savedUserDoc = null;
  await saveWithRetry(async () => {
    const userDocFresh = await User.findOne({ discordId });
    if (!userDocFresh || !Array.isArray(userDocFresh.accounts)) return;
    const account = userDocFresh.accounts.find(
      (a) => normalizeName(a?.accountName) === normalizeName(targetAccountName)
    );
    if (!account || !Array.isArray(account.characters)) return;

    const target = account.characters.find(
      (c) => normalizeName(c?.name || c?.charName) === normalizeName(targetCharName)
    );
    if (!target) return;
    if (!target.assignedRaids) target.assignedRaids = {};

    writeAssignedRaidOverride(target, includeRaidKey, "include");
    writeAssignedRaidOverride(target, excludeRaidKey, "exclude");

    if (typeof userDocFresh.markModified === "function") {
      userDocFresh.markModified("accounts");
    }
    await userDocFresh.save();
    saved = true;
    savedUserDoc = userDocFresh;
  });

  return { ok: saved, userDoc: savedUserDoc };
}

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

module.exports = {
  parseGoldToggleValue,
  toggleParsedGoldRaid,
  toggleRaidGoldDisabled,
  replaceRaidGoldSelection,
  getNextGoldOverride,
  getGoldReplacementRequirement,
};

function resolveGoldOverride(raidData) {
  if (raidData?.goldOverride === "include" || raidData?.goldForced === true) return "include";
  if (raidData?.goldOverride === "exclude" || raidData?.goldDisabled === true) return "exclude";
  return null;
}

function getRaidModeKey(raidKey, raidData, character) {
  const assignedModeKey = getAssignedRaidModeKey(raidData, raidKey);
  if (assignedModeKey) return assignedModeKey;

  const gateDifficulty = raidData?.G1?.difficulty || raidData?.G2?.difficulty || "";
  const gateModeKey = gateDifficulty ? toModeKey(gateDifficulty) : null;
  if (RAID_REQUIREMENTS[raidKey]?.modes?.[gateModeKey]) return gateModeKey;

  return getBestEligibleModeKey(raidKey, Number(character?.itemLevel) || 0) || "normal";
}

function getNextGoldOverride(raidKey, raidData, character) {
  const current = resolveGoldOverride(raidData);
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
