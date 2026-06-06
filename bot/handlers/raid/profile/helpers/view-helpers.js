"use strict";

const {
  preferredSnapshotView,
} = require("./snapshot-view");
const {
  aggregateCharacters,
  flattenCharacters,
  getEntryLabel,
  pickTopChar,
} = require("./aggregate");
const display = require("./display");

const {
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
} = display;

function engravingSummary(engravings, limit = 5) {
  const valid = [...(engravings || [])].filter((engraving) => engraving?.name);
  const lines = valid
    .slice(0, limit)
    .map((engraving) => `${shortLabel(engraving.name, 22)} ${engraving.level || 0}`);
  if (!lines.length) return "N/A";
  // Match arkPassiveNodeSummary: flag the dropped tail instead of hiding it.
  const extra = valid.length - lines.length;
  return extra > 0 ? `${lines.join(", ")} (+${extra})` : lines.join(", ");
}

function arkPassiveSummary(arkPassive) {
  if (!arkPassive) return "N/A";
  const evolution = Number(arkPassive.evolution?.points) || 0;
  const enlightenment = Number(arkPassive.enlightenment?.points) || 0;
  const leap = Number(arkPassive.leap?.points) || 0;
  if (!evolution && !enlightenment && !leap) return "N/A";
  return `Evo ${evolution} / Enl ${enlightenment} / Leap ${leap}`;
}

function arkPassiveNodeSummary(nodes, limit = 5) {
  const entries = [...(nodes || [])]
    .filter((node) => node?.id)
    .slice(0, limit)
    .map((node) => {
      const name = shortLabel(node.name || `#${node.id}`, 26);
      const level = Math.round(Number(node.level) || 0);
      return level ? `${name} Lv.${level}` : name;
    });
  if (!entries.length) return "N/A";
  const extra = Math.max(0, (nodes || []).length - entries.length);
  return extra ? `${entries.join(", ")} (+${extra})` : entries.join(", ");
}

function enlightenmentSummary(arkPassive, fallbackSpec) {
  const tree = arkPassive?.enlightenment;
  if (!tree) return "N/A";
  const spec = shortLabel(tree.spec || fallbackSpec || "", 30);
  const nodes = arkPassiveNodeSummary(tree.nodes);
  if (spec && nodes !== "N/A") return `**${spec}** - ${nodes}`;
  if (spec) return `**${spec}**`;
  return nodes;
}

function contextScoreLine(entry, character) {
  const stats = character?.stats || {};
  const scores = character?.scores || {};
  if (isBibleSummaryProfile(entry, character)) {
    return scoreLine("Bible pct", scores.context);
  }
  const coverage = Number(stats.contextCoverageRate) || 0;
  const sampleCount = Number(stats.contextSampleCountAvg) || 0;
  const contextScore = Number(scores.context);
  if (coverage > 0 || sampleCount > 0 || Number.isFinite(contextScore) && contextScore > 0) {
    return scoreLine("Context", scores.context);
  }
  return "Context: **N/A**";
}

function burstProfileLines(stats) {
  const peak = Number(stats?.avgPeak10sDps) || 0;
  if (peak <= 0) return [];
  const p90Peak = Number(stats?.p90Peak10sDps) || 0;
  const ratio = Number(stats?.avgBurstRatio) || 0;
  return [`Peak 10s: **${shortNumber(peak)}** - p90 ${shortNumber(p90Peak)} - burst x${score(ratio)}`];
}

function bibleOutputLines(stats, scores, isSupport = false) {
  const lines = [
    `Bible pct: **${pct(stats.avgBiblePercentile)}** · overall ${pct(stats.avgOverallBiblePercentile)} · cover ${pct(stats.biblePercentileCoverageRate)}`,
    `Avg DPS: **${shortNumber(stats.avgDps)}** · median ${shortNumber(stats.medianDps)} · p90 ${shortNumber(stats.p90Dps)}`,
  ];
  if (Number(stats.avgRdps) > 0 || Number(stats.avgNdps) > 0) {
    lines.push(`rDPS/nDPS: **${shortNumber(stats.avgRdps)}** / ${shortNumber(stats.avgNdps)}`);
  }
  if (Number(stats.avgUdps) > 0) {
    lines.push(`uDPS: **${shortNumber(stats.avgUdps)}**`);
  }
  if (isSupport && Number(stats.supportBuffCoverageRate) > 0) {
    lines.push(`AP/Brand: ${ratePct(stats.avgSupportAp)} / ${ratePct(stats.avgSupportBrand)}`);
    lines.push(`Identity/Hyper: ${ratePct(stats.avgSupportIdentity)} / ${ratePct(stats.avgSupportHyper)}`);
  }
  lines.push(`Duration: avg **${formatDurationMs(stats.avgDurationMs)}**`);
  lines.push(`Bus logs: **${Math.round(Number(stats.busCount) || 0)}** (${pct(stats.busRate)})`);
  lines.push(`Source confidence: **${pct(scores.sourceConfidence)}**`);
  return lines;
}

function buildVariantSummary(variants, { limit = 4 } = {}) {
  const lines = [...(variants || [])]
    .filter((variant) => variant?.name)
    .sort((a, b) =>
      Number(b?.encounters || 0) - Number(a?.encounters || 0) ||
      Number(b?.lastFightStart || 0) - Number(a?.lastFightStart || 0)
    )
    .slice(0, limit)
    .map((variant) => {
      const pctText = Number(variant.avgOverallBiblePercentile || variant.avgBiblePercentile || variant.avgContextPerformancePercentile) > 0
        ? ` · pct ${pct(variant.avgOverallBiblePercentile || variant.avgBiblePercentile || variant.avgContextPerformancePercentile)}`
        : "";
      return `${shortLabel(variant.name, 22)} ${Math.round(Number(variant.encounters) || 0)} log · DPS ${shortNumber(variant.medianDps || variant.avgDps)}${pctText}`;
    });
  return lines.length ? lines.join("\n") : "N/A";
}

module.exports = {
  aggregateCharacters,
  arkPassiveSummary,
  attackStyleLabel,
  bibleOutputLines,
  buildVariantSummary,
  burstProfileLines,
  confidenceForLogs,
  contextScoreLine,
  engravingSummary,
  enlightenmentSummary,
  flattenCharacters,
  footerTimestamp,
  formatDateMs,
  formatDurationMs,
  getEntryLabel,
  hudFieldName,
  isBibleSummaryProfile,
  latestSnapshotMs,
  pct,
  pickTopChar,
  preferredSnapshotView,
  rangeLabel,
  rangeTag,
  ratePct,
  renderGauge,
  renderPercentGauge,
  roleEmoji,
  roleLabel,
  score,
  scoreLine,
  shortNumber,
  sourceSummary,
  sourceSummaryForEntries,
  sourceTag,
};
