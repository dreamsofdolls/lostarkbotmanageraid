"use strict";

const { t } = require("../../../../services/i18n");

function shortNumber(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : "0.0%";
}

function shortLabel(value, max = 28) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function sourceSummary(sources, limit = 3) {
  const lines = [...(sources || [])]
    .filter((source) => source?.name)
    .slice(0, limit)
    .map((source) => `${shortLabel(source.name)} ${pct(source.share)}`);
  return lines.length ? lines.join(", ") : "N/A";
}

function ratePct(value) {
  const n = Number(value) || 0;
  const normalized = n > 1 ? n / 100 : n;
  return pct(Math.max(0, Math.min(1, normalized)) * 100);
}

function attackStyleLabel(value) {
  if (value === "back") return "Back Attack";
  if (value === "front") return "Front Attack";
  return "Hit Master";
}

function roleLabel(character, lang = "vi") {
  if (character?.classRole === "support" && character?.role === "dps") return t("raidProfile.labels.dpsBuild", lang);
  if (character?.role === "support") return t("raidProfile.labels.supportBuild", lang);
  if (character?.role === "dps") return t("raidProfile.labels.dps", lang);
  return t("raidProfile.labels.unknown", lang);
}

function roleEmoji(character) {
  return character?.role === "support" ? "🛡️" : "⚔️";
}

function score(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : "0.0";
}

function renderGauge(value, { suffix = "", width = 10 } = {}) {
  const cells = Math.max(4, Math.min(10, Math.round(Number(width) || 10)));
  const n = Number(value);
  if (!Number.isFinite(n)) return `\`${"▱".repeat(cells)}\` **N/A**`;
  const clamped = Math.max(0, Math.min(100, n));
  const filled = Math.round((clamped / 100) * cells);
  const empty = Math.max(0, cells - filled);
  return `\`${"▰".repeat(filled)}${"▱".repeat(empty)}\` **${score(n)}${suffix}**`;
}

function renderPercentGauge(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "`▱▱▱▱▱▱▱▱▱▱` **N/A**";
  return renderGauge(Math.max(0, Math.min(100, n)), { suffix: "%" });
}

function scoreLine(label, value, opts) {
  return `${label}: ${renderGauge(value, opts)}`;
}

function hudFieldName(label) {
  return `// ${String(label || "").trim().toUpperCase()}`;
}

function latestSnapshotMs(entries) {
  return Math.max(0, ...(entries || []).map((entry) => Number(entry?.receivedAt || entry?.generatedAt) || 0));
}

// Snapshot footer renders in the VIEWER's timezone (keyed off their language),
// since an embed footer can't carry a live Discord <t:..> tag. vi -> VN,
// jp -> Tokyo, en -> UTC (English has no single region, so the neutral
// reference). Offsets are derived by Intl, not hardcoded; none of these zones
// observe DST.
const PROFILE_SNAPSHOT_TZ_BY_LANG = {
  vi: { locale: "vi-VN", timeZone: "Asia/Ho_Chi_Minh" },
  jp: { locale: "ja-JP", timeZone: "Asia/Tokyo" },
  en: { locale: "en-GB", timeZone: "UTC" },
};

function validTimestampMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function snapshotOffsetLabel(when, timeZone) {
  // Pull just the "GMT+7" token from a formatted date and show it as "UTC+7"
  // (UTC reads more universally than GMT); a UTC zone stays "UTC".
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(when);
  const token = parts.find((part) => part.type === "timeZoneName")?.value || "UTC";
  return token.replace("GMT", "UTC");
}

function formatSnapshotDateMs(ms, lang = "vi") {
  const n = validTimestampMs(ms);
  if (!n) return "N/A";
  // Absolute string (footers don't render <t:..>). Date + time are built
  // separately so the (UTC+N) marker lands at the end rather than mid-string,
  // where Intl's own timeZoneName option would awkwardly place it.
  const { locale, timeZone } = PROFILE_SNAPSHOT_TZ_BY_LANG[lang] || PROFILE_SNAPSHOT_TZ_BY_LANG.vi;
  const when = new Date(n);
  const day = new Intl.DateTimeFormat(locale, {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone,
  }).format(when);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone,
  }).format(when);
  return `${day} ${time} (${snapshotOffsetLabel(when, timeZone)})`;
}

function footerTimestamp(ms, lang = "vi") {
  const n = validTimestampMs(ms);
  if (!n) return t("raidProfile.footer.snapshotMissing", lang);
  return t("raidProfile.footer.snapshotAt", lang, { date: formatSnapshotDateMs(n, lang) });
}

function formatDateMs(ms, lang = "vi") {
  const n = validTimestampMs(ms);
  if (!n) return t("raidProfile.dateMissing", lang);
  return `<t:${Math.floor(n / 1000)}:R>`;
}

function formatDurationMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return "0s";
  const totalSeconds = Math.round(n / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function confidenceForLogs(logs) {
  const n = Number(logs) || 0;
  if (n >= 20) return "High";
  if (n >= 5) return "Medium";
  return "Low";
}

function confidenceLabelForLogs(logs, lang = "vi") {
  const key = confidenceForLogs(logs).toLowerCase();
  return t(`raidProfile.confidenceLevels.${key}`, lang);
}

function isBibleSummaryProfile(entry, character = null) {
  return entry?.source === "bible" || character?.stats?.profileDataDepth === "bible-summary";
}

function sourceTag(source, lang = "vi") {
  return source === "bible"
    ? t("raidProfile.source.bible", lang)
    : t("raidProfile.source.local", lang);
}

function rangeTag(rangeType, lang = "vi") {
  return rangeType === "weekly"
    ? t("raidProfile.range.weekly", lang)
    : t("raidProfile.range.full", lang);
}

function rangeLabel(entry) {
  return entry?.rangeType === "weekly" ? "weekly" : "full";
}

function sourceSummaryForEntries(entries, lang = "vi") {
  const tags = [...new Set((entries || []).map((entry) => sourceTag(entry?.source, lang)))];
  return tags.length ? tags.join(" + ") : "N/A";
}

module.exports = {
  attackStyleLabel,
  confidenceLabelForLogs,
  confidenceForLogs,
  footerTimestamp,
  formatDateMs,
  formatSnapshotDateMs,
  formatDurationMs,
  hudFieldName,
  isBibleSummaryProfile,
  latestSnapshotMs,
  pct,
  rangeLabel,
  rangeTag,
  ratePct,
  renderGauge,
  renderPercentGauge,
  roleEmoji,
  roleLabel,
  score,
  scoreLine,
  shortLabel,
  shortNumber,
  sourceSummary,
  sourceSummaryForEntries,
  sourceTag,
};
