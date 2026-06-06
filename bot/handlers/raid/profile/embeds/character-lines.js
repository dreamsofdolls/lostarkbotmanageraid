"use strict";

const {
  hudFieldName,
  pct,
  ratePct,
  score,
  scoreLine,
  shortNumber,
} = require("../helpers/display");

/**
 * embeds/character-lines.js
 * One build's compact "#3-rich" metric table: a SCORE column + a role-aware
 * driver column (the two inline -> a 2-column row), then a full-width detail
 * block with the secondary metrics + the build line. Reads stats + scores so
 * the same helper renders the primary build AND (for flex characters) the alt
 * build from `character.altBuild.{stats,scores}`.
 */

/**
 * Build the embed fields for a single build's metric table.
 * @param {string} role - "support" or "dps" (the build's role, not the class)
 * @param {object} stats - the build's stats object
 * @param {object} scores - the build's scores object
 * @param {{spec?: string, isBibleSummary?: boolean}} [opts]
 * @returns {Array<{name: string, value: string, inline: boolean}>} 3 fields:
 *   SCORE (inline), role driver (inline), full-width detail + build line.
 */
function buildBuildFields(role, stats, scores, { spec = "", isBibleSummary = false } = {}) {
  const isSupport = role === "support";
  const s = stats || {};
  const sc = scores || {};

  const scoreField = {
    name: hudFieldName("score"),
    value: [
      scoreLine("Ov", sc.overall),
      scoreLine("MVP", sc.mvp),
      scoreLine("Surv", sc.survival),
      scoreLine("Consist", sc.consistency),
    ].join("\n"),
    inline: true,
  };

  let driverField;
  let detailLines;
  if (isSupport) {
    const drivers = [scoreLine("rDPS imp", sc.supportUptime)];
    if (!isBibleSummary) {
      drivers.push(
        `Supporter: **${pct(s.avgSupporterPercent)}** · Radiant ${pct(s.radiantSupportRate)}`,
        `Sup rank: **${s.supporterRankValidCount ? `${score(s.avgSupporterRank)}/${score(s.supporterCountAvg)}` : "N/A"}**`,
      );
    }
    drivers.push(`AP/Brand: **${ratePct(s.avgSupportAp)}** / **${ratePct(s.avgSupportBrand)}**`);
    driverField = { name: hudFieldName("support"), value: drivers.join("\n"), inline: true };
    detailLines = isBibleSummary
      ? [`Id/Hyper: ${ratePct(s.avgSupportIdentity)} / ${ratePct(s.avgSupportHyper)}`]
      : [
          `Id/Hyper: ${ratePct(s.avgSupportIdentity)} / ${ratePct(s.avgSupportHyper)} · Synergy **${shortNumber(s.avgSynergyGivenPerMinute)}**/min · Protection **${score(sc.protection)}**`,
          `Deathless **${pct(s.deathlessRate)}** · Taken **${shortNumber(s.avgDamageTakenPerMinute)}**/min·${pct(s.avgDamageTakenShare)} · Incap **${score(s.avgIncapacitations)}**`,
        ];
  } else {
    const out = [scoreLine("Context", s.avgContextPerformancePercentile)];
    if (isBibleSummary) {
      out.push(
        `Bible pct: **${pct(s.avgOverallBiblePercentile || s.avgBiblePercentile)}**`,
        `Avg DPS: **${shortNumber(s.avgDps)}**`,
        `Median: **${shortNumber(s.medianDps)}**`,
      );
    } else {
      out.push(
        `Damage share: **${pct(s.avgDamageShare)}**`,
        `Avg DPS: **${shortNumber(s.avgDps)}**`,
        `Peak 10s: **${shortNumber(s.avgPeak10sDps)}**`,
      );
    }
    driverField = { name: hudFieldName("output"), value: out.join("\n"), inline: true };
    detailLines = isBibleSummary
      ? [`Deathless **${pct(s.deathlessRate)}** · Deaths ${score(s.avgDeaths)}`]
      : [
          `CPM **${score(s.avgCastsPerMinute)}** · Crit ${pct(s.avgCritRate)} · Counter ${score(s.avgCounters)} · Stagger ${shortNumber(s.avgStaggerPerMinute)}/min`,
          `Deathless **${pct(s.deathlessRate)}** · Taken **${shortNumber(s.avgDamageTakenPerMinute)}**/min·${pct(s.avgDamageTakenShare)} · Incap **${score(s.avgIncapacitations)}**`,
        ];
  }

  // combatPower is a raw magnitude (~millions) -> shortNumber, not score().
  const cp = Number(s.latestCombatPower) || Number(s.avgCombatPower) || 0;
  const buildBits = [
    spec ? `\`${spec}\`` : null,
    cp ? `CP **${shortNumber(cp)}**` : null,
    `Active **${pct(s.avgActiveTimeRate != null ? s.avgActiveTimeRate : 100)}**`,
    (!isSupport && Number(s.avgRank) > 0) ? `rank **${score(s.avgRank)}**` : null,
  ].filter(Boolean);

  const detailField = {
    name: hudFieldName(isSupport ? "uptime · survival" : "mechanics · survival"),
    value: [...detailLines, `Build: ${buildBits.join(" · ")}`].join("\n"),
    inline: false,
  };

  return [scoreField, driverField, detailField];
}

module.exports = {
  buildBuildFields,
};
