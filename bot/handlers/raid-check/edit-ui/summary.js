"use strict";

const { t } = require("../../../services/i18n");
const { getRaidModeLabel } = require("../../../utils/raid/common/labels");

function getRaidCheckEditStatusLabel({ statusType, gate, lang }) {
  if (statusType === "complete") {
    return t("raid-check.editFlow.statusLabelComplete", lang);
  }
  if (statusType === "reset") {
    return t("raid-check.editFlow.statusLabelReset", lang);
  }
  if (gate) {
    return t("raid-check.editFlow.statusLabelProcess", lang, { gate });
  }
  return t("raid-check.editFlow.statusLabelProcessFallback", lang);
}

const APPLY_RESULT_SUMMARY_BUILDERS = [
  {
    when: ({ result }) => result?.noRoster,
    build: ({ lang, UI }) => [
      t("raid-check.editFlow.applySummaryNoRoster", lang, {
        warnIcon: UI.icons.warn,
      }),
    ],
  },
  {
    when: ({ result }) => result?.matched === 0,
    build: ({ targetChar, lang, UI }) => [
      t("raid-check.editFlow.applySummaryCharNotFound", lang, {
        warnIcon: UI.icons.warn,
        charName: targetChar.charName,
      }),
    ],
  },
  {
    when: ({ result }) => Boolean(result?.ineligibleItemLevel),
    build: ({ result, raidMeta, raidLabel, lang, UI }) => [
      t("raid-check.editFlow.applySummaryIneligible", lang, {
        warnIcon: UI.icons.warn,
        itemLevel: result.ineligibleItemLevel,
        raidLabel,
        minItemLevel: raidMeta.minItemLevel,
      }),
    ],
  },
  {
    when: ({ result }) => result?.alreadyComplete,
    build: ({ targetChar, raidLabel, lang, UI }) => [
      t("raid-check.editFlow.applySummaryAlreadyComplete", lang, {
        infoIcon: UI.icons.info,
        charName: targetChar.charName,
        raidLabel,
      }),
    ],
  },
  {
    when: ({ result }) => result?.alreadyReset,
    build: ({ targetChar, raidLabel, lang, UI }) => [
      t("raid-check.editFlow.applySummaryAlreadyReset", lang, {
        infoIcon: UI.icons.info,
        charName: targetChar.charName,
        raidLabel,
      }),
    ],
  },
  {
    when: () => true,
    build: ({ result, targetChar, raidLabel, statusLabel, lang, UI }) => {
      const parts = [
        t("raid-check.editFlow.applySummaryDone", lang, {
          doneIcon: UI.icons.done,
          statusLabel,
          charName: targetChar.charName,
          raidLabel,
        }),
      ];
      if (result?.modeResetCount > 0) {
        parts.push(t("raid-check.editFlow.applySummaryModeWipe", lang));
      }
      return parts;
    },
  },
];

const DM_OUTCOME_SUMMARY_BUILDERS = {
  sent: ({ lang }) => t("raid-check.editFlow.applySummaryDmSent", lang),
  failed: ({ lang, UI }) =>
    t("raid-check.editFlow.applySummaryDmFailed", lang, {
      warnIcon: UI.icons.warn,
    }),
  "skipped-self": ({ lang }) =>
    t("raid-check.editFlow.applySummaryDmSkippedSelf", lang),
};

function buildRaidCheckEditApplySummary({
  result,
  targetChar,
  raidMeta,
  statusType,
  gate,
  dmOutcome,
  lang,
  UI,
}) {
  const statusLabel = getRaidCheckEditStatusLabel({ statusType, gate, lang });
  const raidLabel = getRaidModeLabel(raidMeta.raidKey, raidMeta.modeKey, lang);
  const context = {
    result,
    targetChar,
    raidMeta,
    statusLabel,
    raidLabel,
    lang,
    UI,
  };
  const summaryParts = APPLY_RESULT_SUMMARY_BUILDERS
    .find((entry) => entry.when(context))
    .build(context);
  const dmSummary = DM_OUTCOME_SUMMARY_BUILDERS[dmOutcome]?.({ lang, UI });
  if (dmSummary) {
    summaryParts.push(dmSummary);
  }
  summaryParts.push("");
  summaryParts.push(
    t("raid-check.editFlow.applySummaryHint", lang, { raidLabel })
  );
  return {
    message: summaryParts.join("\n"),
    statusLabel,
    raidLabel,
  };
}

module.exports = {
  buildRaidCheckEditApplySummary,
  getRaidCheckEditStatusLabel,
};
