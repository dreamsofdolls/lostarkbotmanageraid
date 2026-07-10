"use strict";

const { t: translate } = require("../../i18n");

const PARSE_ERROR_HINTS = {
  "multi-gate": ({ parsed, UI, lang, t }) =>
    t("text-parser.multiGate", lang, {
      icon: UI.icons.warn,
      gates: parsed.gates.join(", "),
    }),
  "multi-raid": ({ parsed, UI, lang, t }) =>
    t("text-parser.multiRaid", lang, {
      icon: UI.icons.warn,
      raids: parsed.raids.join(", "),
    }),
  "multi-difficulty": ({ parsed, UI, lang, t }) =>
    t("text-parser.multiDifficulty", lang, {
      icon: UI.icons.warn,
      difficulties: parsed.difficulties.join(", "),
    }),
  "reset-with-difficulty": ({ UI, lang, t }) =>
    t("text-parser.resetWithDifficulty", lang, { icon: UI.icons.warn }),
  "reset-with-gate": ({ UI, lang, t }) =>
    t("text-parser.resetWithGate", lang, { icon: UI.icons.warn }),
};

function resolveRaidLevelResetMeta({ raidKey, RAID_REQUIREMENT_MAP, getRaidLabel }) {
  const candidates = Object.values(RAID_REQUIREMENT_MAP || {})
    .filter((meta) => meta?.raidKey === raidKey);
  const candidate = candidates.find((meta) => meta.modeKey === "normal")
    || candidates.find((meta) => meta.modeKey !== "solo")
    || candidates[0];
  if (!candidate) return null;

  return {
    ...candidate,
    label: typeof getRaidLabel === "function"
      ? getRaidLabel(raidKey)
      : candidate.label,
    // Reset is raid-level and must not be blocked by an arbitrary mode's
    // item-level threshold. applyRaidSet preserves the stored mode because a
    // reset never writes raidData.modeKey.
    minItemLevel: 0,
  };
}

function expandRaidChannelEffectiveGates({ gate, raidMeta, getGatesForRaid }) {
  if (!gate) return [];
  const allGates = getGatesForRaid(raidMeta.raidKey);
  const gateIndex = allGates.indexOf(gate);
  return gateIndex >= 0 ? allGates.slice(0, gateIndex + 1) : [gate];
}

function resolveParsedRaidUpdate({
  parsed,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  getRaidLabel,
  UI,
  lang,
  t = translate,
}) {
  if (!parsed) return { action: "ignore" };

  const parseErrorHint = PARSE_ERROR_HINTS[parsed.error];
  if (parseErrorHint) {
    return {
      action: "hint",
      content: parseErrorHint({ parsed, UI, lang, t }),
    };
  }

  const { raidKey, modeKey, charNames, gate, action } = parsed;
  if (!Array.isArray(charNames) || charNames.length === 0) {
    return { action: "ignore" };
  }

  if (action === "reset") {
    const raidMeta = resolveRaidLevelResetMeta({
      raidKey,
      RAID_REQUIREMENT_MAP,
      getRaidLabel,
    });
    if (!raidMeta) {
      return {
        action: "hint",
        content: t("text-parser.invalidCombo", lang, {
          icon: UI.icons.warn,
          raidKey,
          modeKey: "reset",
        }),
      };
    }
    return {
      action: "update",
      raidMeta,
      charNames,
      statusType: "reset",
      effectiveGates: [],
    };
  }

  const raidValue = `${raidKey}_${modeKey}`;
  const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
  if (!raidMeta) {
    return {
      action: "hint",
      content: t("text-parser.invalidCombo", lang, {
        icon: UI.icons.warn,
        raidKey,
        modeKey,
      }),
    };
  }

  if (gate) {
    const validGates = getGatesForRaid(raidMeta.raidKey);
    if (!validGates.includes(gate)) {
      return {
        action: "hint",
        content: t("text-parser.invalidGate", lang, {
          icon: UI.icons.warn,
          gate,
          raidLabel: raidMeta.label,
          validGates: validGates.map((g) => `\`${g}\``).join(", "),
        }),
      };
    }
  }

  return {
    action: "update",
    raidMeta,
    charNames,
    statusType: gate ? "process" : "complete",
    effectiveGates: expandRaidChannelEffectiveGates({
      gate,
      raidMeta,
      getGatesForRaid,
    }),
  };
}

module.exports = {
  expandRaidChannelEffectiveGates,
  resolveRaidLevelResetMeta,
  resolveParsedRaidUpdate,
};
