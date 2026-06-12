"use strict";

const { RAID_REQUIREMENTS, isGoldBound } = require("../../../models/Raid");
const { normalizeName, toModeKey } = require("../../../utils/raid/common/shared");
const {
  getAssignedRaidModeKey,
  getBestEligibleModeKey,
} = require("../../../utils/raid/common/character/assigned-raids");

const VALID_RAID_KEYS = new Set(Object.keys(RAID_REQUIREMENTS));

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
    delete raidData.goldDisabled;
    delete raidData.goldForced;
    if (nextOverride) raidData.goldOverride = nextOverride;
    else delete raidData.goldOverride;
    target.assignedRaids[raidKey] = raidData;
    if (typeof userDocFresh.markModified === "function") {
      userDocFresh.markModified("accounts");
    }
    await userDocFresh.save();
  });
  return {
    override: nextOverride,
    disabled: nextOverride === "exclude",
  };
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
    return { handled: true, ok: true, ...result };
  } catch (err) {
    logger.error?.("[raid-status gold toggle] save failed:", err?.message || err);
    return { handled: true, ok: false, error: err };
  }
}

module.exports = {
  parseGoldToggleValue,
  toggleParsedGoldRaid,
  toggleRaidGoldDisabled,
  getNextGoldOverride,
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
