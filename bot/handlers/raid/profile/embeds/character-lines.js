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
 * One build's compact Endfield metric table. Reads stats + scores so the same
 * helper renders the visible primary build AND (for flex characters) the alt
 * build from `character.altBuild.{stats,scores}`.
 */

function buildSpecName(build, fallback = "") {
  return String(build?.arkPassive?.enlightenment?.spec || build?.spec || fallback || "").trim();
}

function buildArkLine(build, stats) {
  if (build?.arkPassiveActive === true) return "Ark **ON**";
  if (build?.arkPassiveActive === false) return "Ark **OFF**";
  const rate = Number(stats?.arkPassiveRate);
  return Number.isFinite(rate) && rate > 0 ? `Ark **${pct(rate)}**` : null;
}

function valueLine(label, value) {
  return `${label}: **${value}**`;
}

function statScoreLine(label, value) {
  return valueLine(label, score(value));
}

function buildSurvivalLines(stats) {
  return [
    valueLine("Deathless", pct(stats.deathlessRate)),
    valueLine("Taken/min", shortNumber(stats.avgDamageTakenPerMinute)),
    valueLine("Taken share", pct(stats.avgDamageTakenShare)),
    valueLine("Incap (avg)", score(stats.avgIncapacitations)),
  ];
}

/**
 * Build the embed fields for a single build's metric table.
 * @param {string} role - "support" or "dps" (the build's role, not the class)
 * @param {object} stats - the build's stats object
 * @param {object} scores - the build's scores object
 * @param {{spec?: string, build?: object, isBibleSummary?: boolean}} [opts]
 * @returns {Array<{name: string, value: string, inline: boolean}>}
 */
function buildBuildFields(role, stats, scores, { spec = "", build = null, isBibleSummary = false } = {}) {
  const isSupport = role === "support";
  const s = stats || {};
  const sc = scores || {};
  const buildSpec = buildSpecName(build, spec);

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
  let secondaryField;
  if (isSupport) {
    const drivers = [scoreLine("rDPS imp", sc.raidContribution || sc.supportUptime)];
    if (!isBibleSummary) {
      drivers.push(
        valueLine("Supporter%", pct(s.avgSupporterPercent)),
        valueLine("Radiant%", pct(s.radiantSupportRate)),
        valueLine("Sup rank", s.supporterRankValidCount ? `${score(s.avgSupporterRank)} / ${score(s.supporterCountAvg)}` : "N/A"),
      );
    }
    driverField = { name: hudFieldName("support"), value: drivers.join("\n"), inline: true };
    const uptimeLines = [
      valueLine("AP / Brand", `${ratePct(s.avgSupportAp)} / ${ratePct(s.avgSupportBrand)}`),
      valueLine("Identity/Hyper", `${ratePct(s.avgSupportIdentity)} / ${ratePct(s.avgSupportHyper)}`),
    ];
    if (!isBibleSummary) {
      uptimeLines.push(
        valueLine("Synergy/min", shortNumber(s.avgSynergyGivenPerMinute)),
        valueLine("Protection", score(sc.protection)),
      );
    }
    secondaryField = { name: hudFieldName("uptime"), value: uptimeLines.join("\n"), inline: true };
  } else {
    const out = [scoreLine("CTX pct", s.avgContextPerformancePercentile)];
    if (isBibleSummary) {
      out.push(
        `Bible pct: **${pct(s.avgOverallBiblePercentile || s.avgBiblePercentile)}**`,
        `Avg DPS: **${shortNumber(s.avgDps)}**`,
        `Median: **${shortNumber(s.medianDps)}**`,
      );
    } else {
      out.push(
        valueLine("Damage share", pct(s.avgDamageShare)),
        valueLine("Avg / median DPS", `${shortNumber(s.avgDps)} / ${shortNumber(s.medianDps)}`),
        valueLine("Peak 10s · burst", `${shortNumber(s.avgPeak10sDps)} x${score(s.avgBurstRatio)}`),
      );
    }
    driverField = { name: hudFieldName("output"), value: out.join("\n"), inline: true };
    secondaryField = isBibleSummary
      ? {
          name: hudFieldName("sample"),
          value: [
            valueLine("Context cov", pct(s.contextCoverageRate || s.biblePercentileCoverageRate || s.overallBiblePercentileCoverageRate)),
            valueLine("Logs", Math.round(Number(s.encounters) || 0)),
          ].join("\n"),
          inline: true,
        }
      : {
          name: hudFieldName("mechanics"),
          value: [
            statScoreLine("Casts/min (CPM)", s.avgCastsPerMinute),
            valueLine("Crit rate", pct(s.avgCritRate)),
            statScoreLine("Counters", s.avgCounters),
            valueLine("Stagger/min", shortNumber(s.avgStaggerPerMinute)),
          ].join("\n"),
          inline: true,
        };
  }

  // combatPower is a raw magnitude (~millions) -> shortNumber, not score().
  const cp = Number(build?.combatPower) || Number(s.latestCombatPower) || Number(s.avgCombatPower) || 0;
  const buildBits = [
    buildSpec ? `\`${buildSpec}\`` : null,
    cp ? `CP **${shortNumber(cp)}**` : null,
    buildArkLine(build, s),
    `Active **${pct(s.avgActiveTimeRate != null ? s.avgActiveTimeRate : 100)}**`,
    !isBibleSummary ? `rank **${Number(s.avgRank) > 0 ? score(s.avgRank) : "—"}**` : null,
  ].filter(Boolean);

  const survivalField = {
    name: hudFieldName("survival · tank"),
    value: (isBibleSummary
      ? [valueLine("Deathless", pct(s.deathlessRate)), valueLine("Deaths", score(s.avgDeaths))]
      : buildSurvivalLines(s)).join("\n"),
    inline: true,
  };

  const buildField = {
    name: hudFieldName("build"),
    value: buildBits.length ? buildBits.join(" · ") : "N/A",
    inline: false,
  };

  return [scoreField, driverField, secondaryField, survivalField, buildField];
}

module.exports = {
  buildBuildFields,
};
