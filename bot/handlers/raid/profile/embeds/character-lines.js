"use strict";

const { t } = require("../../../../services/i18n");
const {
  hudFieldName,
  pct,
  ratePct,
  score,
  scoreLine,
  shortNumber,
} = require("../helpers/display");
const {
  pack2Columns,
} = require("../../../../utils/raid/common/shared");

/**
 * embeds/character-lines.js
 * One build's compact Endfield metric table. Reads stats + scores so the same
 * helper renders the visible primary build AND (for flex characters) the alt
 * build from `character.altBuild.{stats,scores}`.
 */

function buildArkLine(build, stats, lang) {
  if (build?.arkPassiveActive === true) return `${label("arkPassive", lang)} **${label("on", lang)}**`;
  if (build?.arkPassiveActive === false) return `${label("arkPassive", lang)} **${label("off", lang)}**`;
  const rate = Number(stats?.arkPassiveRate);
  return Number.isFinite(rate) && rate > 0 ? `${label("arkPassive", lang)} **${pct(rate)}**` : null;
}

function valueLine(label, value) {
  return `${label}: **${value}**`;
}

function statScoreLine(label, value) {
  return valueLine(label, score(value));
}

function label(key, lang) {
  return t(`raidProfile.labels.${key}`, lang);
}

function localizedScoreLine(key, value, lang) {
  return scoreLine(label(key, lang), value, { width: 8 });
}

function firstFiniteValue(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function optionalPct(stats, key) {
  if (!hasOwn(stats, key)) return "N/A";
  const number = Number(stats[key]);
  return Number.isFinite(number) ? pct(number) : "N/A";
}

function buildSurvivalLines(stats, lang) {
  return [
    valueLine(label("deathless", lang), pct(stats.deathlessRate)),
    valueLine(label("takenPerMin", lang), shortNumber(stats.avgDamageTakenPerMinute)),
    valueLine(label("takenShare", lang), pct(stats.avgDamageTakenShare)),
    valueLine(label("incapAvg", lang), score(stats.avgIncapacitations)),
  ];
}

function buildMechanicsLines(stats, lang) {
  return [
    statScoreLine(label("castsPerMin", lang), stats.avgCastsPerMinute),
    statScoreLine(label("counters", lang), stats.avgCounters),
    valueLine(label("staggerPerMin", lang), shortNumber(stats.avgStaggerPerMinute)),
  ];
}

/**
 * Build the embed fields for a single build's metric table.
 * @param {string} role - "support" or "dps" (the build's role, not the class)
 * @param {object} stats - the build's stats object
 * @param {object} scores - the build's scores object
 * @param {{build?: object, isBibleSummary?: boolean, lang?: string}} [opts]
 * @returns {Array<{name: string, value: string, inline: boolean}>}
 */
function buildBuildFields(role, stats, scores, { build = null, isBibleSummary = false, lang = "vi" } = {}) {
  const isSupport = role === "support";
  const s = stats || {};
  const sc = scores || {};

  const scoreField = {
    name: hudFieldName(label("scoreSection", lang)),
    value: [
      localizedScoreLine("scoreOverall", sc.overall, lang),
      localizedScoreLine("scoreMvp", sc.mvp, lang),
      localizedScoreLine("scoreSurvival", sc.survival, lang),
      localizedScoreLine("scoreConsistency", sc.consistency, lang),
    ].join("\n"),
    inline: true,
  };

  let driverField;
  let secondaryField;
  let mechanicsField = null;
  let supportRankField = null;
  if (isSupport) {
    const drivers = [localizedScoreLine("supportImpact", firstFiniteValue(sc.raidContribution, sc.supportUptime), lang)];
    if (!isBibleSummary) {
      drivers.push(
        valueLine(label("contribution", lang), optionalPct(s, "avgSynergyGivenShare")),
        valueLine(label("rContribution", lang), optionalPct(s, "avgRdpsDamageGivenShare")),
      );
      supportRankField = {
        name: hudFieldName(label("supporterSection", lang)),
        value: [
          valueLine(label("supporterPercent", lang), pct(s.avgSupporterPercent)),
          valueLine(label("radiantPercent", lang), pct(s.radiantSupportRate)),
          valueLine(label("supportRank", lang), s.supporterRankValidCount ? `${score(s.avgSupporterRank)} / ${score(s.supporterCountAvg)}` : "N/A"),
        ].join("\n"),
        inline: true,
      };
    }
    driverField = { name: hudFieldName(label("supportSection", lang)), value: drivers.join("\n"), inline: true };
    const uptimeLines = [
      valueLine(label("apBrand", lang), `${ratePct(s.avgSupportAp)}/${ratePct(s.avgSupportBrand)}`),
      valueLine(label("identityHyper", lang), `${ratePct(s.avgSupportIdentity)}/${ratePct(s.avgSupportHyper)}`),
    ];
    if (!isBibleSummary) {
      uptimeLines.push(
        valueLine(label("protection", lang), score(sc.protection)),
      );
      mechanicsField = {
        name: hudFieldName(label("mechanicsSection", lang)),
        value: buildMechanicsLines(s, lang).join("\n"),
        inline: true,
      };
    }
    secondaryField = { name: hudFieldName(label("uptimeSection", lang)), value: uptimeLines.join("\n"), inline: true };
  } else {
    const out = [localizedScoreLine("contextPercentile", s.avgContextPerformancePercentile, lang)];
    if (isBibleSummary) {
      out.push(
        valueLine(label("biblePercentile", lang), pct(s.avgOverallBiblePercentile || s.avgBiblePercentile)),
        valueLine(label("avgDps", lang), shortNumber(s.avgDps)),
        valueLine(label("medianDps", lang), shortNumber(s.medianDps)),
      );
    } else {
      out.push(
        valueLine(label("damageShare", lang), pct(s.avgDamageShare)),
        valueLine(label("avgMedianDps", lang), `${shortNumber(s.avgDps)}/${shortNumber(s.medianDps)}`),
        valueLine(label("peakBurst", lang), `${shortNumber(s.avgPeak10sDps)}x${score(s.avgBurstRatio)}`),
      );
    }
    driverField = { name: hudFieldName(label("outputSection", lang)), value: out.join("\n"), inline: true };
    const mechanicsLines = buildMechanicsLines(s, lang);
    secondaryField = isBibleSummary
      ? {
          name: hudFieldName(label("sampleSection", lang)),
          value: [
            valueLine(label("contextCoverage", lang), pct(s.contextCoverageRate || s.biblePercentileCoverageRate || s.overallBiblePercentileCoverageRate)),
            valueLine(label("logs", lang), Math.round(Number(s.encounters) || 0)),
          ].join("\n"),
          inline: true,
        }
      : {
          name: hudFieldName(label("mechanicsSection", lang)),
          value: [
            mechanicsLines[0],
            valueLine(label("critRate", lang), pct(s.avgCritRate)),
            ...mechanicsLines.slice(1),
          ].join("\n"),
          inline: true,
        };
  }

  // combatPower is a raw magnitude (~millions) -> shortNumber, not score().
  const cp = Number(build?.combatPower) || Number(s.latestCombatPower) || Number(s.avgCombatPower) || 0;
  const buildBits = [
    cp ? `${label("combatPower", lang)} **${shortNumber(cp)}**` : null,
    buildArkLine(build, s, lang),
    `${label("activeTime", lang)} **${pct(s.avgActiveTimeRate != null ? s.avgActiveTimeRate : 100)}**`,
    !isBibleSummary ? `${label("rank", lang)} **${Number(s.avgRank) > 0 ? score(s.avgRank) : "—"}**` : null,
  ].filter(Boolean);

  const survivalField = {
    name: hudFieldName(label("survivalTankSection", lang)),
    value: (isBibleSummary
      ? [valueLine(label("deathless", lang), pct(s.deathlessRate)), valueLine(label("deaths", lang), score(s.avgDeaths))]
      : buildSurvivalLines(s, lang)).join("\n"),
    inline: true,
  };

  const buildField = {
    name: hudFieldName(label("buildSection", lang)),
    value: buildBits.length ? buildBits.join(" · ") : "N/A",
    inline: false,
  };

  return [
    ...pack2Columns([
      scoreField,
      driverField,
      secondaryField,
      supportRankField,
      mechanicsField,
      survivalField,
    ].filter(Boolean)),
    buildField,
  ];
}

module.exports = {
  buildBuildFields,
};
