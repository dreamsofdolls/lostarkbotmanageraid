import { t } from "/sync/js/core/i18n.js";

// Relative-time formatter for "last sync 5 min ago" display. Decays
// through s/min/h/d buckets; everything older than a day shows in days
// to keep the chip short. Returns null when ms is missing/0 so the
// caller can swap to "never synced" copy.
export function formatRelativeTime(ms) {
  if (!ms || typeof ms !== "number") return null;
  const diff = Date.now() - ms;
  if (diff < 0) return t("preview.statsRelativeJustNow");
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return t("preview.statsRelativeJustNow");
  if (sec < 60) return t("preview.statsRelativeSec", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("preview.statsRelativeMin", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("preview.statsRelativeHour", { n: hr });
  const day = Math.floor(hr / 24);
  return t("preview.statsRelativeDay", { n: day });
}

export function formatGold(n) {
  if (!Number.isFinite(n) || n <= 0) return "0G";
  // Comma thousand separators are used across all three supported locales; LA
  // community reads "12,500G" everywhere regardless of UI lang.
  return `${n.toLocaleString("en-US")}G`;
}


export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
