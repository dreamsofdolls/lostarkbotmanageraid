"use strict";

const {
  appendApplyResult,
  writeErrorEntry,
} = require("./apply-results");

function buildWriteRaidMeta(raidMeta, bucket) {
  return { ...raidMeta, raidKey: bucket.raidKey, modeKey: bucket.modeKey };
}

async function applySingleWrite({
  discordId,
  applyRaidSetForDiscordId,
  requireLocalSyncEnabled,
  bucket,
  raidMeta,
  effectiveGates,
  lists,
}) {
  try {
    const result = await applyRaidSetForDiscordId({
      discordId,
      executorId: null,
      characterName: bucket.charName,
      rosterName: null,
      raidMeta,
      statusType: "process",
      effectiveGates,
      requireLocalSyncEnabled,
    });
    appendApplyResult(result, bucket, effectiveGates, lists);
  } catch (err) {
    console.error(
      `[local-sync/apply] write failed char=${bucket.charName} raid=${bucket.raidKey}:`,
      err?.message || err
    );
    lists.rejected.push(writeErrorEntry(bucket, err));
  }
}

function buildBatchEntry({ bucket, raidMeta, effectiveGates }) {
  return {
    characterName: bucket.charName,
    rosterName: null,
    raidMeta,
    statusType: "process",
    effectiveGates,
  };
}

async function applyBatchWrites({
  discordId,
  applyRaidSetBatchForDiscordId,
  requireLocalSyncEnabled,
  pendingWrites,
  lists,
}) {
  if (pendingWrites.length === 0) return;

  try {
    const results = await applyRaidSetBatchForDiscordId({
      discordId,
      requireLocalSyncEnabled,
      entries: pendingWrites.map(buildBatchEntry),
    });
    for (let i = 0; i < pendingWrites.length; i += 1) {
      const pending = pendingWrites[i];
      appendApplyResult(results?.[i], pending.bucket, pending.effectiveGates, lists);
    }
  } catch (err) {
    console.error("[local-sync/apply] batch write failed:", err?.message || err);
    for (const pending of pendingWrites) {
      lists.rejected.push(writeErrorEntry(pending.bucket, err));
    }
  }
}

module.exports = {
  applyBatchWrites,
  applySingleWrite,
  buildWriteRaidMeta,
};
