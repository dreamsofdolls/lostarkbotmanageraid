"use strict";

const {
  upsertEncounterSummaries,
} = require("../local-sync/profile-storage");

const {
  BIBLE_PROFILE_SOURCE,
  MIN_PROFILE_DURATION_MS,
  buildBibleProfileSnapshot,
  buildBibleProfileSnapshotFromEncounterSummaries,
  buildBibleWeeklySnapshotFromEncounterSummaries,
  filterSummariesForCurrentRoster,
  booleanFlag,
  durationToMs,
  normalizeDifficultyToModeKey,
  roleForLog,
} = require("./bible-profile-builder");

async function readExistingSnapshotMeta(discordId, RaidProfileSnapshot) {
  const existing = await RaidProfileSnapshot.findOne({ discordId })
    .select("criteria accounts rangeType source rangeSnapshots")
    .lean();
  return existing || null;
}

function snapshotHasCharacters(snapshot) {
  return (snapshot?.accounts || []).some((account) =>
    Array.isArray(account?.characters) && account.characters.length > 0
  );
}

function isBibleSnapshot(snapshot) {
  return snapshot?.source === "bible" ||
    snapshot?.criteria?.source === "lostark.bible" ||
    snapshot?.criteria?.dataDepth === "bible-summary";
}

function shouldPromoteBibleSnapshot(existing, snapshot) {
  if (!existing) return true;
  const existingHasCharacters = snapshotHasCharacters(existing);
  if (existingHasCharacters && !isBibleSnapshot(existing)) return false;
  const existingRangeType = existing.rangeType || existing.criteria?.range?.type || "full";
  if (!existingHasCharacters || existingRangeType !== "full") return true;
  return existing.source === "bible" && snapshot?.source === "bible";
}

function shouldWriteBibleWeeklySnapshot(existing) {
  const weekly = existing?.rangeSnapshots?.weekly;
  if (snapshotHasCharacters(weekly) && !isBibleSnapshot(weekly)) return false;
  const existingRangeType = existing?.rangeType || existing?.criteria?.range?.type || "full";
  if (snapshotHasCharacters(existing) && existingRangeType === "weekly" && !isBibleSnapshot(existing)) {
    return false;
  }
  return true;
}

function shouldWriteBibleFullSnapshot(existing) {
  const existingHasCharacters = snapshotHasCharacters(existing);
  const existingRangeType = existing?.rangeType || existing?.criteria?.range?.type || "full";
  if (existingHasCharacters && existingRangeType === "full" && !isBibleSnapshot(existing)) {
    return false;
  }
  const full = existing?.rangeSnapshots?.full;
  return !snapshotHasCharacters(full) || isBibleSnapshot(full);
}

function buildBibleSnapshotUpdate({
  discordId,
  weeklySnapshot,
  fullSnapshot = null,
  promotePrimary,
  writeFull = false,
  writeWeekly = true,
}) {
  const set = {
    discordId,
  };
  if (writeWeekly) set["rangeSnapshots.weekly"] = weeklySnapshot;
  if (writeFull && fullSnapshot) {
    set["rangeSnapshots.full"] = fullSnapshot;
  }
  if (promotePrimary) {
    const primary = fullSnapshot || weeklySnapshot;
    Object.assign(set, {
      ...primary,
      discordId,
      rangeType: primary.rangeType || primary.criteria?.range?.type || "weekly",
    });
  }
  return set;
}

async function readBibleEncounterSummaries(discordId, RaidProfileEncounter) {
  if (!RaidProfileEncounter || typeof RaidProfileEncounter.find !== "function") return [];
  const query = RaidProfileEncounter.find({
    discordId,
    $or: [
      { "db.source": "lostark.bible" },
      { "metrics.dataDepth": "bible-summary" },
    ],
  });
  if (query && typeof query.sort === "function") {
    return await query.sort({ fightStart: 1 }).lean();
  }
  if (query && typeof query.lean === "function") {
    return await query.lean();
  }
  return Array.isArray(query) ? query : [];
}

function createBibleProfileSyncService({
  RaidProfileSnapshot,
  RaidProfileEncounter = null,
  getCharacterName,
  getCharacterClass,
  getRaidGateForBoss,
  RAID_REQUIREMENT_MAP,
  log = console,
  isDevUser = () => true,
}) {
  if (!RaidProfileSnapshot) {
    throw new Error("[auto-manage-profile-sync] RaidProfileSnapshot model required");
  }
  const deps = {
    getCharacterName,
    getCharacterClass,
    getRaidGateForBoss,
    RAID_REQUIREMENT_MAP,
  };

  async function syncRaidProfileFromBibleCollected({
    discordId,
    userDoc,
    weekResetStart,
    collected,
    logLabel = "[auto-manage-profile]",
  }) {
    if (!discordId || !userDoc || !Array.isArray(collected) || collected.length === 0) {
      return { ok: false, reason: "empty" };
    }
    // Preview gate: skip the profile-light upsert for non-preview users.
    if (!isDevUser(discordId)) {
      return { ok: false, reason: "preview-gated" };
    }

    const built = buildBibleProfileSnapshot({
      discordId,
      userDoc,
      weekResetStart,
      collected,
      deps,
    });
    if (!built) return { ok: false, reason: "no-valid-logs" };

    try {
      const encounterWrite = await upsertEncounterSummaries({
        discordId,
        summaries: built.encounterSummaries,
        RaidProfileEncounter,
      });
      const existing = await readExistingSnapshotMeta(discordId, RaidProfileSnapshot);
      const storedSummaries = filterSummariesForCurrentRoster(
        await readBibleEncounterSummaries(discordId, RaidProfileEncounter),
        userDoc,
        deps
      );
      const weeklyBuilt = storedSummaries.length
        ? buildBibleWeeklySnapshotFromEncounterSummaries({ summaries: storedSummaries, weekResetStart })
        : null;
      const fullBuilt = storedSummaries.length
        ? buildBibleProfileSnapshotFromEncounterSummaries({ summaries: storedSummaries })
        : null;
      const writeWeekly = shouldWriteBibleWeeklySnapshot(existing);
      const writeFull = !!fullBuilt?.snapshot && shouldWriteBibleFullSnapshot(existing);
      const weeklySnapshot = weeklyBuilt?.snapshot || built.snapshot;
      const primarySnapshot = writeFull ? fullBuilt.snapshot : weeklySnapshot;
      const promotePrimary = shouldPromoteBibleSnapshot(existing, primarySnapshot);
      await RaidProfileSnapshot.findOneAndUpdate(
        { discordId },
        {
          $set: buildBibleSnapshotUpdate({
            discordId,
            weeklySnapshot,
            fullSnapshot: fullBuilt?.snapshot || null,
            writeFull,
            writeWeekly,
            promotePrimary,
          }),
        },
        { upsert: true, setDefaultsOnInsert: true, new: true }
      );
      return {
        ok: true,
        source: BIBLE_PROFILE_SOURCE,
        promoted: promotePrimary,
        totals: primarySnapshot.totals,
        encounterWrite,
        fullEncounterCount: fullBuilt?.snapshot?.totals?.encounterCount || 0,
      };
    } catch (err) {
      log.warn(`${logLabel} bible profile save failed for ${discordId}:`, err?.message || err);
      return { ok: false, reason: "save-failed", error: err?.message || String(err) };
    }
  }

  return {
    syncRaidProfileFromBibleCollected,
  };
}

module.exports = {
  BIBLE_PROFILE_SOURCE,
  MIN_PROFILE_DURATION_MS,
  buildBibleProfileSnapshot,
  buildBibleProfileSnapshotFromEncounterSummaries,
  buildBibleWeeklySnapshotFromEncounterSummaries,
  createBibleProfileSyncService,
  booleanFlag,
  durationToMs,
  normalizeDifficultyToModeKey,
  roleForLog,
};
