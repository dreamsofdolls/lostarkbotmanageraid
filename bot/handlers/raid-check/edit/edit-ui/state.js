"use strict";

const { t } = require("../../../../services/i18n");
const { getRaidModeLabel } = require("../../../../utils/raid/common/labels");

const DOT = "\u00b7";
const LOCK = "\u{1f512}";

function resolvePickedRaidLabel({ state, raidRequirementMap, lang }) {
  if (!state.selectedRaid) return null;
  const meta = raidRequirementMap[state.selectedRaid];
  if (meta?.raidKey && meta?.modeKey) {
    return getRaidModeLabel(meta.raidKey, meta.modeKey, lang);
  }
  return meta?.label || state.raidMeta?.label || state.selectedRaid;
}

const NEXT_STEP_RULES = [
  {
    when: ({ state }) => state.applied,
    build: ({ lang }) => t("raid-check.editFlow.nextStepCompleted", lang),
  },
  {
    when: ({ state }) => state.scopeAll && !state.raidMeta,
    build: ({ lang }) => t("raid-check.editFlow.nextStepPickRaid", lang),
  },
  {
    when: ({ state }) => state.scopeAll && state.editableByUser.size === 0,
    build: ({ lang }) => t("raid-check.editFlow.nextStepNoEditable", lang),
  },
  {
    when: ({ state }) => !state.selectedUser,
    build: ({ lang }) => t("raid-check.editFlow.nextStepPickUser", lang),
  },
  {
    when: ({ state }) => !state.selectedChar,
    build: ({ state, pickedRaidLabel, lang }) => {
      const raidLabel = state.raidMeta
        ? getRaidModeLabel(state.raidMeta.raidKey, state.raidMeta.modeKey, lang)
        : pickedRaidLabel || "";
      return t("raid-check.editFlow.nextStepPickChar", lang, { raidLabel });
    },
  },
  {
    when: ({ state }) => state.awaitingGate,
    build: ({ lang }) => t("raid-check.editFlow.nextStepPickGate", lang),
  },
  {
    when: () => true,
    build: ({ lang }) => t("raid-check.editFlow.nextStepPickStatus", lang),
  },
];

const USER_LABEL_RULES = [
  {
    when: ({ state }) => state.selectedUser,
    build: ({ state }) =>
      state.displayMap.get(state.selectedUser) || state.selectedUser,
  },
  {
    when: ({ state }) =>
      state.scopeAll && state.preSelectedUserId && state.preSelectedDisplayName,
    build: ({ state, lang }) =>
      t("raid-check.editFlow.preSelectHint", lang, {
        name: state.preSelectedDisplayName,
      }),
  },
  {
    when: () => true,
    build: ({ lang }) => t("raid-check.editFlow.noneSelected", lang),
  },
];

function resolveCharLabel({ state, lang }) {
  if (!state.selectedChar) {
    return t("raid-check.editFlow.noneSelected", lang);
  }
  const logOffSuffix = state.selectedChar.publicLogDisabled
    ? ` ${DOT} ${LOCK} log off`
    : "";
  return `${state.selectedChar.charName} ${DOT} ${Math.round(
    state.selectedChar.itemLevel
  )}${logOffSuffix}`;
}

function resolveHeaderLine({ state, raidLabel, lang }) {
  if (state.scopeAll) {
    return state.raidMeta
      ? t("raid-check.editFlow.headerScopeAllPicked", lang, { raidLabel })
      : t("raid-check.editFlow.headerScopeAllUnpicked", lang);
  }
  return t("raid-check.editFlow.headerScopeLocked", lang, { raidLabel });
}

function resolveRaidLineSuffix({ state, lang }) {
  if (state.scopeAll) {
    return state.raidMeta
      ? t("raid-check.editFlow.raidSuffixScopeAllPicked", lang)
      : "";
  }
  return t("raid-check.editFlow.raidSuffixScopeLocked", lang);
}

function resolveRaidCheckEditEmbedState({
  state,
  raidRequirementMap,
  lang,
}) {
  const pickedRaidLabel = resolvePickedRaidLabel({
    state,
    raidRequirementMap,
    lang,
  });
  const raidLabel =
    pickedRaidLabel || t("raid-check.editFlow.noneSelected", lang);
  const nextStep = NEXT_STEP_RULES.find((entry) =>
    entry.when({ state, pickedRaidLabel, lang })
  ).build({ state, pickedRaidLabel, lang });
  const userLabel = USER_LABEL_RULES.find((entry) =>
    entry.when({ state, lang })
  ).build({ state, lang });

  return {
    pickedRaidLabel,
    raidLabel,
    nextStep,
    userLabel,
    charLabel: resolveCharLabel({ state, lang }),
    headerLine: resolveHeaderLine({ state, raidLabel, lang }),
    raidLineSuffix: resolveRaidLineSuffix({ state, lang }),
  };
}

module.exports = {
  resolvePickedRaidLabel,
  resolveRaidCheckEditEmbedState,
};
