"use strict";

function snapshotHasCharacters(snapshot) {
  return (snapshot?.accounts || []).some((account) =>
    Array.isArray(account?.characters) && account.characters.length > 0
  );
}

function snapshotDataRank(snapshot) {
  if (!snapshotHasCharacters(snapshot)) return 0;
  const source = snapshot?.source || "";
  const criteriaSource = snapshot?.criteria?.source || "";
  const dataDepth = snapshot?.criteria?.dataDepth || "";
  if (source === "local" || criteriaSource === "encounters.db") return 3;
  if (source === "bible" || criteriaSource === "lostark.bible" || dataDepth === "bible-summary") return 1;
  return 2;
}

function shouldUseFullSnapshot(root, full) {
  if (!snapshotHasCharacters(full)) return false;
  if (!snapshotHasCharacters(root)) return true;
  const rootRank = snapshotDataRank(root);
  const fullRank = snapshotDataRank(full);
  if (fullRank < rootRank) return false;
  if (fullRank > rootRank) return true;
  const rootRange = root?.rangeType || root?.criteria?.range?.type || "full";
  const fullRange = full?.rangeType || full?.criteria?.range?.type || "full";
  return fullRange === "full" && rootRange !== "full";
}

function preferredSnapshotView(snapshot) {
  const full = snapshot?.rangeSnapshots?.full;
  if (shouldUseFullSnapshot(snapshot, full)) {
    return {
      ...snapshot,
      ...full,
      discordId: snapshot.discordId,
      rangeSnapshots: snapshot.rangeSnapshots,
    };
  }
  return snapshot;
}

module.exports = {
  preferredSnapshotView,
  shouldUseFullSnapshot,
  snapshotDataRank,
  snapshotHasCharacters,
};
