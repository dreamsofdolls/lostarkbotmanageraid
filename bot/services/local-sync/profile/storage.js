"use strict";

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

async function upsertEncounterSummaries({ discordId, summaries, RaidProfileEncounter }) {
  if (!RaidProfileEncounter || !Array.isArray(summaries) || summaries.length === 0) {
    return { received: Array.isArray(summaries) ? summaries.length : 0, upserted: 0, modified: 0 };
  }
  const receivedAt = Date.now();
  const ops = summaries.map((summary) => {
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
  });
  const result = await RaidProfileEncounter.bulkWrite(ops, { ordered: false });
  return {
    received: summaries.length,
    upserted: result?.upsertedCount || 0,
    modified: result?.modifiedCount || 0,
  };
}

module.exports = {
  shouldPromoteSnapshot,
  buildSnapshotUpdate,
  upsertEncounterSummaries,
};
