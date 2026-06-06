"use strict";

const DEFAULT_ENCOUNTER_SUMMARY_BATCH_SIZE = 250;

async function shouldPromoteSnapshot(clean, discordId, RaidProfileSnapshot) {
  if (clean?.criteria?.range?.type !== "weekly") return true;
  const existing = await RaidProfileSnapshot.findOne({ discordId })
    .select("criteria accounts rangeType")
    .lean();
  if (!existing) return true;
  const existingHasCharacters = (existing.accounts || []).some((account) =>
    Array.isArray(account?.characters) && account.characters.length > 0
  );
  const existingRangeType = existing.rangeType || existing.criteria?.range?.type || "full";
  return !existingHasCharacters || existingRangeType !== "full";
}

function buildSnapshotUpdate({ discordId, clean, promotePrimary }) {
  const rangeType = clean?.criteria?.range?.type === "weekly" ? "weekly" : "full";
  const { encounterSummaries: _encounterSummaries, ...snapshot } = clean || {};
  const set = {
    discordId,
    [`rangeSnapshots.${rangeType}`]: snapshot,
  };
  if (promotePrimary) {
    Object.assign(set, {
      ...snapshot,
      discordId,
      rangeType,
    });
  }
  return set;
}

function buildEncounterSummaryUpsertOp({ discordId, summary, receivedAt }) {
  const { rangeType, ...summaryFields } = summary;
  const update = {
    $set: {
      ...summaryFields,
      discordId,
      receivedAt,
    },
  };
  if (rangeType === "full") {
    update.$set.rangeType = "full";
  } else {
    update.$setOnInsert = { rangeType: "weekly" };
  }
  return {
    updateOne: {
      filter: {
        discordId,
        encounterId: summary.encounterId,
        characterNameKey: summary.characterNameKey,
      },
      update,
      upsert: true,
    },
  };
}

function normalizeBatchSize(value) {
  const batchSize = Number(value);
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    return DEFAULT_ENCOUNTER_SUMMARY_BATCH_SIZE;
  }
  return Math.max(1, Math.floor(batchSize));
}

async function upsertEncounterSummaries({
  discordId,
  summaries,
  RaidProfileEncounter,
  batchSize = DEFAULT_ENCOUNTER_SUMMARY_BATCH_SIZE,
}) {
  if (!RaidProfileEncounter || !Array.isArray(summaries) || summaries.length === 0) {
    return { received: Array.isArray(summaries) ? summaries.length : 0, upserted: 0, modified: 0 };
  }
  const receivedAt = Date.now();
  const effectiveBatchSize = normalizeBatchSize(batchSize);
  let upserted = 0;
  let modified = 0;
  for (let i = 0; i < summaries.length; i += effectiveBatchSize) {
    const ops = summaries
      .slice(i, i + effectiveBatchSize)
      .map((summary) => buildEncounterSummaryUpsertOp({ discordId, summary, receivedAt }));
    const result = await RaidProfileEncounter.bulkWrite(ops, { ordered: false });
    upserted += result?.upsertedCount || 0;
    modified += result?.modifiedCount || 0;
  }
  return {
    received: summaries.length,
    upserted,
    modified,
  };
}

module.exports = {
  DEFAULT_ENCOUNTER_SUMMARY_BATCH_SIZE,
  shouldPromoteSnapshot,
  buildSnapshotUpdate,
  buildEncounterSummaryUpsertOp,
  upsertEncounterSummaries,
};
