"use strict";

const User = require("../../../models/user");
const { getRaidRequirementMap } = require("../../../domain/raid-catalog");
const {
  getCharacterName,
  normalizeName,
} = require("../../../utils/raid/common/shared");
const { applyLocalSyncDeltas } = require("./apply/apply");
const { resolveCurrentWeekStartMs } = require("./apply/apply-targets");
const { assertPartyTargetFanout } = require("./party-policy");

const TARGET_USER_SELECT = [
  "discordId",
  "autoManageEnabled",
  "localSyncEnabled",
  "accounts.accountName",
  "accounts.characters.name",
  "accounts.characters.class",
  "accounts.characters.itemLevel",
  "accounts.characters.isGoldEarner",
  "accounts.characters.assignedRaids",
].join(" ");

function emptyPropagationResult() {
  return { applied: [], ignored: [], rejected: [] };
}

function buildPartyDeltaIndex(deltas) {
  const index = new Map();
  for (const delta of deltas || []) {
    const charName = String(delta?.charName || "").trim();
    const key = normalizeName(charName);
    if (!key) continue;
    if (!index.has(key)) index.set(key, { charName, deltas: [] });
    index.get(key).deltas.push(delta);
  }
  return index;
}

async function loadOptedInRosterUsers(UserModel, participantNames) {
  if (participantNames.length === 0) return [];
  let query = UserModel.find({
    "accounts.characters.name": { $in: participantNames },
    $or: [
      { localSyncEnabled: true },
      { autoManageEnabled: true },
    ],
  });
  if (typeof query?.select === "function") query = query.select(TARGET_USER_SELECT);
  if (typeof query?.collation === "function") {
    query = query.collation({ locale: "en", strength: 2 });
  }
  if (typeof query?.lean === "function") query = query.lean();
  const users = await query;
  return Array.isArray(users) ? users : [];
}

function buildRosterNameSet(userDoc) {
  const names = new Set();
  for (const account of userDoc?.accounts || []) {
    for (const character of account?.characters || []) {
      const key = normalizeName(getCharacterName(character));
      if (key) names.add(key);
    }
  }
  return names;
}

function selectUserPartyDeltas(userDoc, partyDeltasOrIndex) {
  const deltaIndex = partyDeltasOrIndex instanceof Map
    ? partyDeltasOrIndex
    : buildPartyDeltaIndex(partyDeltasOrIndex);
  const selected = [];
  for (const rosterName of buildRosterNameSet(userDoc)) {
    selected.push(...(deltaIndex.get(rosterName)?.deltas || []));
  }
  return selected;
}

function decorateEntry(entry, discordId) {
  return {
    ...entry,
    targetDiscordId: discordId,
    propagated: true,
  };
}

function appendIgnoredEntries(target, entries, discordId, fallbackReason = "ignored") {
  for (const entry of entries || []) {
    target.push(decorateEntry({
      ...entry,
      reason: entry?.reason || fallbackReason,
    }, discordId));
  }
}

async function propagatePartyDeltas(partyDeltas, deps = {}) {
  assertPartyTargetFanout(partyDeltas);
  if (partyDeltas.length === 0) return emptyPropagationResult();

  const UserModel = deps.UserModel || User;
  if (!UserModel || typeof UserModel.find !== "function") {
    throw new Error("[local-sync/party] UserModel.find required");
  }

  const deltaIndex = buildPartyDeltaIndex(partyDeltas);
  const participantNames = [...deltaIndex.values()].map((entry) => entry.charName);
  const users = await loadOptedInRosterUsers(UserModel, participantNames);
  const result = emptyPropagationResult();
  const currentWeekStartMs = resolveCurrentWeekStartMs(deps.currentWeekStartMs);

  for (const userDoc of users) {
    const discordId = String(userDoc?.discordId || "").trim();
    if (!discordId) continue;
    const deltas = selectUserPartyDeltas(userDoc, deltaIndex);
    if (deltas.length === 0) continue;

    const summary = await applyLocalSyncDeltas(discordId, deltas, {
      applyRaidSetForDiscordId: deps.applyRaidSetForDiscordId,
      applyRaidSetBatchForDiscordId: deps.applyRaidSetBatchForDiscordId || null,
      getRaidRequirementMap: deps.getRaidRequirementMap || getRaidRequirementMap,
      userDoc,
      currentWeekStartMs,
      requireAnySyncEnabled: true,
      requireRaidUntouched: true,
      preserveStoredModePreference: false,
    });

    result.applied.push(...(summary.applied || []).map((entry) => (
      decorateEntry(entry, discordId)
    )));
    for (const entry of summary.rejected || []) {
      const decorated = decorateEntry(entry, discordId);
      if (entry?.reason === "write_error") result.rejected.push(decorated);
      else result.ignored.push(decorated);
    }
    appendIgnoredEntries(result.ignored, summary.skipped, discordId);
    appendIgnoredEntries(result.ignored, summary.unmapped, discordId, "unmapped");
  }

  return result;
}

module.exports = {
  propagatePartyDeltas,
};
