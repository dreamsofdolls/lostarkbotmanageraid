"use strict";

export function resolvePreviewLastSync(summary = {}) {
  const lastSync = summary.lastSync || {};
  const localMs = Number(lastSync.localSyncAt) || 0;
  const bibleMs = Number(lastSync.autoManageSyncAt) || 0;

  if (summary.scope === "solo") {
    return localMs > 0
      ? { ms: localMs, labelKey: "preview.statsLastSyncSoloMode" }
      : null;
  }

  if (localMs === 0 && bibleMs === 0) return null;
  return localMs >= bibleMs
    ? { ms: localMs, labelKey: "preview.statsLastSyncLocalMode" }
    : { ms: bibleMs, labelKey: "preview.statsLastSyncBibleMode" };
}
