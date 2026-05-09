"use strict";

const { getRaidGateForBoss, getGatesForRaid } = require("../../models/Raid");
const { getCharacterName, normalizeName, toModeLabel } = require("../../utils/raid/shared");

/**
 * Apply incoming local-sync deltas from the web companion. Each delta
 * came from `encounters.db` filtered to last-7-day cleared rows; this
 * module maps boss + difficulty → (raidKey, modeKey, gateIndex), expands
 * gate cumulatively (G2 cleared implies G1 cleared - matches the text
 * parser's effectiveGates semantics), groups by char + raid+mode, and
 * delegates to `applyRaidSetForDiscordId` so the resulting writes go
 * through the same auth + retry path as the slash command.
 *
 * Returns a structured summary so the web UI can show:
 *   - applied:  per-char raid clears actually written
 *   - skipped:  encounters that mapped fine but were already complete
 *   - unmapped: bosses we don't recognize (early data signal for new content)
 *   - rejected: char names not in the user's roster
 *
 * The function is module-level (not closure-bound) so tests can stub
 * applyRaidSetForDiscordId without spinning up the full handler factory.
 */

// LOA Logs encounters.db `difficulty` column values vs our internal modeKey.
// Permissive on the input side because LOA Logs has shifted difficulty
// strings between versions (Trial → Inferno → Nightmare). All map to
// the same raid metadata for our purposes.
const DIFFICULTY_TO_MODE_KEY = {
  normal: "normal",
  hard: "hard",
  nightmare: "nightmare",
  trial: "nightmare",
  inferno: "nightmare",
};

function normalizeDifficulty(raw) {
  const text = String(raw || "").trim().toLowerCase();
  return DIFFICULTY_TO_MODE_KEY[text] || null;
}

/**
 * Map one raw delta from the web companion to a structured target. Returns
 * null when the boss isn't in BOSS_TO_RAID_GATE (caller buckets it as
 * "unmapped"). Difficulty unrecognized → falls back to "normal" since
 * Brelshaza/Armoche etc. all default to Normal in-game and missing the
 * difficulty field is more likely a data oddity than user intent.
 */
function resolveTarget(delta) {
  const bossInfo = getRaidGateForBoss(delta.boss);
  if (!bossInfo) return null;
  const modeKey = normalizeDifficulty(delta.difficulty) || "normal";
  return {
    raidKey: bossInfo.raidKey,
    modeKey,
    gate: bossInfo.gate,
  };
}

/**
 * Group deltas by (charName, raidKey, modeKey) so a roster with 5 G1
 * clears + 3 G2 clears of the same raid+mode produces ONE write per
 * char (effectiveGates [G1, G2]) instead of 8. Picks the highest gate
 * index per group to drive cumulative expansion.
 */
function bucketize(deltas) {
  const buckets = new Map();
  for (const d of deltas) {
    if (!d.cleared) continue;
    const target = resolveTarget(d);
    if (!target) continue;
    const charName = String(d.charName || "").trim();
    if (!charName) continue;
    const allGates = getGatesForRaid(target.raidKey);
    const gateIndex = allGates.indexOf(target.gate);
    if (gateIndex < 0) continue;
    const bucketKey = `${charName.toLowerCase()}::${target.raidKey}::${target.modeKey}`;
    const existing = buckets.get(bucketKey);
    const lastClearMs = Number(d.lastClearMs) || 0;
    if (!existing || gateIndex > existing.gateIndex) {
      buckets.set(bucketKey, {
        charName,
        raidKey: target.raidKey,
        modeKey: target.modeKey,
        gateIndex,
        lastClearMs,
      });
    } else if (gateIndex === existing.gateIndex && lastClearMs > existing.lastClearMs) {
      existing.lastClearMs = lastClearMs;
    }
  }
  return [...buckets.values()];
}

function findRosterCharacter(userDoc, charName) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
  const target = normalizeName(charName);
  if (!target) return null;
  for (const account of userDoc.accounts) {
    const chars = Array.isArray(account?.characters) ? account.characters : [];
    for (const character of chars) {
      if (normalizeName(getCharacterName(character)) === target) return character;
    }
  }
  return null;
}

function getAssignedRaid(character, raidKey) {
  return character?.assignedRaids?.[raidKey] || {};
}

function gatesAlreadyComplete(character, bucket, effectiveGates) {
  const selectedDifficulty = normalizeName(toModeLabel(bucket.modeKey));
  const assignedRaid = getAssignedRaid(character, bucket.raidKey);
  if (!Array.isArray(effectiveGates) || effectiveGates.length === 0) return false;
  return effectiveGates.every((gate) => {
    const entry = assignedRaid?.[gate];
    if (!(Number(entry?.completedDate) > 0)) return false;
    const entryDifficulty = normalizeName(entry?.difficulty || "");
    return !entryDifficulty || entryDifficulty === selectedDifficulty;
  });
}

function classifyBucketAgainstRoster(userDoc, bucket, raidMeta, effectiveGates) {
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    return { action: "reject", reason: "no_roster" };
  }

  const character = findRosterCharacter(userDoc, bucket.charName);
  if (!character) return { action: "reject", reason: "char_not_in_roster" };

  const charItemLevel = Number(character.itemLevel) || 0;
  if (charItemLevel < raidMeta.minItemLevel) {
    return { action: "reject", reason: "ilvl_too_low", ineligibleItemLevel: charItemLevel };
  }

  if (gatesAlreadyComplete(character, bucket, effectiveGates)) {
    return { action: "skip", reason: "already_complete", displayName: getCharacterName(character) || bucket.charName };
  }

  return { action: "apply", displayName: getCharacterName(character) || bucket.charName };
}

/**
 * Main entry. `deltas` shape (from web companion):
 *   [{ boss, difficulty, cleared, charName, lastClearMs }]
 *
 * Deps:
 *   - applyRaidSetForDiscordId: the raid-set handler's write path
 *   - getRaidRequirementMap: maps "raidKey_modeKey" to the meta object
 *     applyRaidSetForDiscordId expects (label, minItemLevel, raidKey, modeKey)
 *
 * Returns:
 *   { applied: [...], skipped: [...], unmapped: [...], rejected: [...] }
 *
 * Each list contains user-facing-renderable entries so the web UI can
 * group by status without knowing the internal shape.
 */
async function applyLocalSyncDeltas(discordId, deltas, deps = {}) {
  const { applyRaidSetForDiscordId, getRaidRequirementMap, userDoc = null } = deps;
  if (typeof applyRaidSetForDiscordId !== "function") {
    throw new Error("[local-sync/apply] applyRaidSetForDiscordId required in deps");
  }
  if (typeof getRaidRequirementMap !== "function") {
    throw new Error("[local-sync/apply] getRaidRequirementMap required in deps");
  }
  if (!discordId) throw new Error("[local-sync/apply] discordId required");
  if (!Array.isArray(deltas)) throw new Error("[local-sync/apply] deltas must be an array");

  const applied = [];
  const skipped = [];
  const unmapped = [];
  const rejected = [];

  // Track unmapped bosses BEFORE bucketize so the count reflects the
  // raw stream (10 unmapped clears = 10 entries, not 1 deduped one) -
  // gives the user a clearer picture of how much LOA Logs data we're
  // missing aliases for.
  for (const d of deltas) {
    if (!d.cleared) continue;
    const target = resolveTarget(d);
    if (!target) {
      unmapped.push({
        boss: d.boss || "(unknown)",
        difficulty: d.difficulty || "(unknown)",
        charName: d.charName || "(unknown)",
      });
    }
  }

  const buckets = bucketize(deltas);
  const reqMap = getRaidRequirementMap();

  for (const bucket of buckets) {
    const metaKey = `${bucket.raidKey}_${bucket.modeKey}`;
    const raidMeta = reqMap[metaKey];
    if (!raidMeta) {
      // Mapped to a raid+mode combo that doesn't exist in the
      // requirement table (e.g. an old "armoche_inferno" if the table
      // changes). Bucket as unmapped so user sees they need a bot update.
      unmapped.push({
        boss: `${bucket.raidKey}/${bucket.modeKey}`,
        difficulty: bucket.modeKey,
        charName: bucket.charName,
      });
      continue;
    }
    const allGates = getGatesForRaid(bucket.raidKey);
    // Cumulative expand: G2 cleared → write [G1, G2]. Mirrors the text
    // parser's behavior so /raid-status shows a fully-cleared raid card,
    // not just the top gate.
    const effectiveGates = allGates.slice(0, bucket.gateIndex + 1);
    if (userDoc) {
      const preflight = classifyBucketAgainstRoster(userDoc, bucket, raidMeta, effectiveGates);
      if (preflight.action === "reject") {
        rejected.push({
          charName: bucket.charName,
          reason: preflight.reason,
          ineligibleItemLevel: preflight.ineligibleItemLevel,
          raidKey: bucket.raidKey,
          modeKey: bucket.modeKey,
          gates: effectiveGates,
        });
        continue;
      }
      if (preflight.action === "skip") {
        skipped.push({
          charName: preflight.displayName || bucket.charName,
          raidKey: bucket.raidKey,
          modeKey: bucket.modeKey,
          gates: effectiveGates,
          reason: preflight.reason,
        });
        continue;
      }
    }
    try {
      const result = await applyRaidSetForDiscordId({
        discordId,
        executorId: null, // user is applying their own data; no helper-Manager flow
        characterName: bucket.charName,
        rosterName: null,
        raidMeta: { ...raidMeta, raidKey: bucket.raidKey, modeKey: bucket.modeKey },
        statusType: "process", // gate-based mark, not full-raid wipe
        effectiveGates,
      });
      if (result.noRoster) {
        rejected.push({
          charName: bucket.charName,
          reason: "no_roster",
          raidKey: bucket.raidKey,
          modeKey: bucket.modeKey,
          gates: effectiveGates,
        });
        continue;
      }
      if (!result.matched) {
        rejected.push({
          charName: bucket.charName,
          reason: "char_not_in_roster",
          raidKey: bucket.raidKey,
          modeKey: bucket.modeKey,
          gates: effectiveGates,
        });
        continue;
      }
      if (result.ineligibleItemLevel) {
        rejected.push({
          charName: bucket.charName,
          reason: "ilvl_too_low",
          ineligibleItemLevel: result.ineligibleItemLevel,
          raidKey: bucket.raidKey,
          modeKey: bucket.modeKey,
          gates: effectiveGates,
        });
        continue;
      }
      if (result.updated) {
        applied.push({
          charName: result.displayName || bucket.charName,
          raidKey: bucket.raidKey,
          modeKey: bucket.modeKey,
          gates: effectiveGates,
          modeResetCount: result.modeResetCount || 0,
        });
      } else {
        // matched + !updated = already complete (alreadyComplete flag).
        skipped.push({
          charName: result.displayName || bucket.charName,
          raidKey: bucket.raidKey,
          modeKey: bucket.modeKey,
          gates: effectiveGates,
          reason: "already_complete",
        });
      }
    } catch (err) {
      console.error(
        `[local-sync/apply] write failed char=${bucket.charName} raid=${bucket.raidKey}:`,
        err?.message || err
      );
      rejected.push({
        charName: bucket.charName,
        reason: "write_error",
        error: err?.message || String(err),
        raidKey: bucket.raidKey,
        modeKey: bucket.modeKey,
      });
    }
  }

  return { applied, skipped, unmapped, rejected };
}

module.exports = {
  applyLocalSyncDeltas,
  // Exposed for tests + the eventual command-side reuse.
  resolveTarget,
  bucketize,
  normalizeDifficulty,
};
