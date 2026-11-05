"use strict";

const { NoticeKind } = require("../../../utils/raid/common/shared");

const VALID_STATUS_TYPES = new Set(["complete", "reset", "process"]);

function createRaidSetInputHelpers({
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  getRaidModeLabel,
  t,
}) {
  function localizedRaidLabel(raidKey, lang) {
    const meta = RAID_REQUIREMENT_MAP[raidKey];
    if (!meta) return raidKey;
    return getRaidModeLabel(meta.raidKey, meta.modeKey, lang);
  }

  function readRaidSetInput(interaction) {
    return {
      rosterName: interaction.options.getString("roster", true).trim(),
      characterName: interaction.options.getString("character", true).trim(),
      raidKey: interaction.options.getString("raid", true),
      statusType: interaction.options.getString("status", true),
      targetGate: interaction.options.getString("gate") || "",
    };
  }

  // Every refusal here is an option to fix, so they share the input kind
  // and read their copy from `raid-set.invalid.<stem>{Title,Description,Tip}`.
  function invalidNotice(stem, lang, vars) {
    return {
      valid: false,
      notice: {
        kind: NoticeKind.INPUT,
        title: t(`raid-set.invalid.${stem}Title`, lang),
        description: t(`raid-set.invalid.${stem}Description`, lang, vars),
        tip: t(`raid-set.invalid.${stem}Tip`, lang),
      },
    };
  }

  function validateRaidSetInput(input, lang) {
    const raidMeta = RAID_REQUIREMENT_MAP[input.raidKey];
    if (!raidMeta) {
      return invalidNotice("raid", lang);
    }

    if (!VALID_STATUS_TYPES.has(input.statusType)) {
      return invalidNotice("status", lang);
    }

    const effectiveGate = input.statusType === "process" ? input.targetGate : "";
    if (input.statusType !== "process") {
      return { valid: true, raidMeta, effectiveGate };
    }

    if (!input.targetGate) {
      return invalidNotice("processNeedsGate", lang);
    }

    const validGates = getGatesForRaid(raidMeta.raidKey);
    if (!validGates.includes(input.targetGate)) {
      return invalidNotice("gate", lang, {
        gate: input.targetGate,
        raidLabel: localizedRaidLabel(input.raidKey, lang),
        validGates: validGates.map((gate) => `\`${gate}\``).join(", "),
      });
    }

    return { valid: true, raidMeta, effectiveGate };
  }

  return {
    localizedRaidLabel,
    readRaidSetInput,
    validateRaidSetInput,
  };
}

module.exports = {
  createRaidSetInputHelpers,
};
