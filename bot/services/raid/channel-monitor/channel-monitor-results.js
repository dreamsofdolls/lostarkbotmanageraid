"use strict";

const { t: translate } = require("../../i18n");

function summarizeRaidChannelResults(results) {
  const list = Array.isArray(results) ? results : [];
  const notFoundResults = list.filter((r) => !r.matched && !r.error);
  const ineligibleResults = list.filter(
    (r) => r.matched && !r.updated && !r.alreadyComplete
  );
  const errorResults = list.filter((r) => r.error);
  const successCount = list.filter((r) => r.updated).length;
  const alreadyCount = list.filter((r) => r.alreadyComplete).length;

  return {
    hadNoRoster: list.some((r) => r.noRoster),
    successCount,
    alreadyCount,
    notFoundResults,
    ineligibleResults,
    errorResults,
    hasProgress: successCount > 0 || alreadyCount > 0,
    hasErrors:
      notFoundResults.length > 0 ||
      ineligibleResults.length > 0 ||
      errorResults.length > 0,
  };
}

function buildRaidChannelErrorHint({
  summary,
  raidMeta,
  authorLang,
  UI,
  t = translate,
}) {
  if (!summary?.hasErrors) return null;

  const sections = [
    {
      results: summary.notFoundResults,
      render: (results) =>
        t("text-parser.errorNotFound", authorLang, {
          icon: UI.icons.warn,
          names: results.map((r) => `\`${r.charName}\``).join(", "),
        }),
    },
    {
      results: summary.ineligibleResults,
      render: (results) =>
        t("text-parser.errorIneligible", authorLang, {
          icon: UI.icons.warn,
          raidLabel: raidMeta.label,
          minItemLevel: raidMeta.minItemLevel,
          names: results
            .map((r) => `**${r.displayName || r.charName}** (iLvl ${r.ineligibleItemLevel})`)
            .join(", "),
        }),
    },
    {
      results: summary.errorResults,
      render: (results) =>
        t("text-parser.errorSystem", authorLang, {
          icon: UI.icons.warn,
          names: results.map((r) => `\`${r.charName}\``).join(", "),
        }),
    },
  ];

  const lines = sections
    .filter((section) => section.results.length > 0)
    .map((section) => section.render(section.results));

  lines.push(
    summary.hasProgress
      ? t("text-parser.errorPartialNote", authorLang)
      : t("text-parser.errorRetryNote", authorLang)
  );
  return lines.join("\n");
}

function buildRaidChannelDmFallbackText({
  results,
  raidMeta,
  effectiveGates,
  authorLang,
  UI,
  userId,
  t = translate,
}) {
  const scope =
    Array.isArray(effectiveGates) && effectiveGates.length > 0
      ? `${raidMeta.label} \u00b7 ${effectiveGates.join(", ")}`
      : raidMeta.label;
  const doneNames = results
    .filter((r) => r.updated)
    .map((r) => `**${r.displayName || r.charName}**`)
    .join(", ");
  const alreadyNames = results
    .filter((r) => r.alreadyComplete)
    .map((r) => `**${r.displayName || r.charName}**`)
    .join(", ");
  const parts = [
    doneNames &&
      t("text-parser.dmFallbackMarkDone", authorLang, {
        scope,
        names: doneNames,
      }),
    alreadyNames &&
      t("text-parser.dmFallbackAlready", authorLang, {
        scope,
        names: alreadyNames,
      }),
  ].filter(Boolean);

  return t("text-parser.dmFallback", authorLang, {
    icon: UI.icons.done,
    userId,
    parts: parts.join("; "),
  });
}

module.exports = {
  buildRaidChannelDmFallbackText,
  buildRaidChannelErrorHint,
  summarizeRaidChannelResults,
};
