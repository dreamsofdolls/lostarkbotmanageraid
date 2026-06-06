"use strict";

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

  function invalidNotice(type, title, description) {
    return { valid: false, notice: { type, title, description } };
  }

  function validateRaidSetInput(input, lang) {
    const raidMeta = RAID_REQUIREMENT_MAP[input.raidKey];
    if (!raidMeta) {
      return invalidNotice(
        "warn",
        t("raid-set.invalid.raidTitle", lang),
        t("raid-set.invalid.raidDescription", lang)
      );
    }

    if (!VALID_STATUS_TYPES.has(input.statusType)) {
      return invalidNotice(
        "warn",
        t("raid-set.invalid.statusTitle", lang),
        t("raid-set.invalid.statusDescription", lang)
      );
    }

    const effectiveGate = input.statusType === "process" ? input.targetGate : "";
    if (input.statusType !== "process") {
      return { valid: true, raidMeta, effectiveGate };
    }

    if (!input.targetGate) {
      return invalidNotice(
        "warn",
        t("raid-set.invalid.processNeedsGateTitle", lang),
        t("raid-set.invalid.processNeedsGateDescription", lang)
      );
    }

    const validGates = getGatesForRaid(raidMeta.raidKey);
    if (!validGates.includes(input.targetGate)) {
      return invalidNotice(
        "warn",
        t("raid-set.invalid.gateTitle", lang),
        t("raid-set.invalid.gateDescription", lang, {
          gate: input.targetGate,
          raidLabel: localizedRaidLabel(input.raidKey, lang),
          validGates: validGates.map((gate) => `\`${gate}\``).join(", "),
        })
      );
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
