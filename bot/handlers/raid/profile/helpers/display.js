"use strict";

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

function roleLabel(character) {
  if (character?.classRole === "support" && character?.role === "dps") return "DPS build";
  if (character?.role === "support") return "SUP";
  if (character?.role === "dps") return "DPS";
  return "Unknown";
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

function footerTimestamp(ms) {
  const n = Number(ms) || 0;
  if (!n) return "SNAPSHOT N/A";
  return `SNAPSHOT ${new Date(n).toISOString().replace(".000Z", "Z")}`;
}

function formatDateMs(ms) {
  const n = Number(ms) || 0;
  if (!n) return "chưa có";
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

function isBibleSummaryProfile(entry, character = null) {
  return entry?.source === "bible" || character?.stats?.profileDataDepth === "bible-summary";
}

function sourceTag(source) {
  return source === "bible" ? "BIBLE" : "LOCAL";
}

function rangeTag(rangeType) {
  return rangeType === "weekly" ? "WEEKLY" : "FULL";
}

function rangeLabel(entry) {
  return entry?.rangeType === "weekly" ? "weekly" : "full";
}

function sourceSummaryForEntries(entries) {
  const tags = [...new Set((entries || []).map((entry) => sourceTag(entry?.source)))];
  return tags.length ? tags.join("+") : "N/A";
}

module.exports = {
  attackStyleLabel,
  confidenceForLogs,
  footerTimestamp,
  formatDateMs,
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
