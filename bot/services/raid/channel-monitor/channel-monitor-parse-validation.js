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
  "invalid-raid": ({ parsed, UI, lang, t }) =>
    t("text-parser.invalidRaid", lang, {
      icon: UI.icons.warn,
      raids: parsed.raids.map((raid) => `\`${raid}\``).join(", "),
    }),
  "raid-after-mode": ({ parsed, UI, lang, t }) =>
    t("text-parser.raidAfterMode", lang, {
      icon: UI.icons.warn,
      raids: parsed.raids.map((raid) => `\`${raid}\``).join(", "),
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

function applyParsedRaidDisplayName(raidMeta, displayName) {
  if (!raidMeta || !displayName) return raidMeta;
  const label = String(raidMeta.label || "");
  const modeKey = String(raidMeta.modeKey || "");
  const fallbackModeLabel = modeKey
    ? `${modeKey.charAt(0).toUpperCase()}${modeKey.slice(1)}`
    : "";
  return {
    ...raidMeta,
    label: /^kazeros(?:\s|$)/i.test(label)
      ? label.replace(/^kazeros/i, displayName)
      : [displayName, fallbackModeLabel].filter(Boolean).join(" "),
  };
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

  const { modeKey, charNames, gate, action } = parsed;
  const raidDisplayNames = parsed.raidDisplayNames || {};
  const raidKeys = [...new Set(
    (Array.isArray(parsed.raidKeys) ? parsed.raidKeys : [parsed.raidKey]).filter(Boolean)
  )];
  if (!Array.isArray(charNames) || charNames.length === 0) {
    return { action: "ignore" };
  }
  if (raidKeys.length === 0) return { action: "ignore" };

  if (action === "reset") {
    const updates = [];
    const invalidRaidKeys = [];
    for (const raidKey of raidKeys) {
      const raidMeta = resolveRaidLevelResetMeta({
        raidKey,
        RAID_REQUIREMENT_MAP,
        getRaidLabel,
      });
      if (!raidMeta) {
        invalidRaidKeys.push(raidKey);
        continue;
      }
      updates.push({
        raidMeta: applyParsedRaidDisplayName(raidMeta, raidDisplayNames[raidKey]),
        statusType: "reset",
        effectiveGates: [],
      });
    }
    if (invalidRaidKeys.length > 0) {
      return {
        action: "hint",
        content: invalidRaidKeys
          .map((raidKey) => t("text-parser.invalidCombo", lang, {
            icon: UI.icons.warn,
            raidKey,
            modeKey: "reset",
          }))
          .join("\n"),
      };
    }
    return {
      action: "update",
      updates,
      charNames,
      ...updates[0],
    };
  }

  const updates = [];
  const invalidRaidKeys = [];
  for (const raidKey of raidKeys) {
    const raidMeta = RAID_REQUIREMENT_MAP[`${raidKey}_${modeKey}`];
    if (!raidMeta) {
      invalidRaidKeys.push(raidKey);
      continue;
    }
    updates.push({
      raidMeta: applyParsedRaidDisplayName(raidMeta, raidDisplayNames[raidKey]),
    });
  }
  if (invalidRaidKeys.length > 0) {
    return {
      action: "hint",
      content: invalidRaidKeys
        .map((raidKey) => t("text-parser.invalidCombo", lang, {
          icon: UI.icons.warn,
          raidKey,
          modeKey,
        }))
        .join("\n"),
    };
  }

  if (gate) {
    const invalidGateUpdates = updates.filter(
      ({ raidMeta }) => !getGatesForRaid(raidMeta.raidKey).includes(gate)
    );
    if (invalidGateUpdates.length > 0) {
      return {
        action: "hint",
        content: invalidGateUpdates
          .map(({ raidMeta }) => t("text-parser.invalidGate", lang, {
            icon: UI.icons.warn,
            gate,
            raidLabel: raidMeta.label,
            validGates: getGatesForRaid(raidMeta.raidKey)
              .map((g) => `\`${g}\``)
              .join(", "),
          }))
          .join("\n"),
      };
    }
  }

  for (const update of updates) {
    update.statusType = gate ? "process" : "complete";
    update.effectiveGates = expandRaidChannelEffectiveGates({
      gate,
      raidMeta: update.raidMeta,
      getGatesForRaid,
    });
  }

  return {
    action: "update",
    updates,
    charNames,
    ...updates[0],
  };
}

module.exports = {
  applyParsedRaidDisplayName,
  expandRaidChannelEffectiveGates,
  resolveRaidLevelResetMeta,
  resolveParsedRaidUpdate,
};
