"use strict";

const { t } = require("../../../services/i18n");
const { getRaidModeLabel } = require("../../../utils/raid/common/labels");

const EDIT_DM_ACTION_BUILDERS = {
  complete: ({ lang }) => t("raid-check.editDm.actionComplete", lang),
  reset: ({ lang }) => t("raid-check.editDm.actionReset", lang),
  process: ({ gate, lang }) =>
    t("raid-check.editDm.actionProcess", lang, {
      gate: gate || t("raid-check.editDm.actionProcessFallback", lang),
    }),
};

function getRaidCheckEditDmActionLine({ statusType, gate, lang }) {
  const buildActionLine =
    EDIT_DM_ACTION_BUILDERS[statusType] || EDIT_DM_ACTION_BUILDERS.process;
  return buildActionLine({ gate, lang });
}

function buildRaidCheckEditDMEmbed({
  EmbedBuilder,
  UI,
  targetChar,
  raidMeta,
  statusType,
  gate,
  modeResetHappened,
  lang = "vi",
}) {
  const actionLine = getRaidCheckEditDmActionLine({ statusType, gate, lang });
  const color = statusType === "reset" ? UI.colors.progress : UI.colors.success;
  const raidLabel = getRaidModeLabel(raidMeta.raidKey, raidMeta.modeKey, lang);
  const lines = [
    t("raid-check.editDm.intro", lang),
    "",
    t("raid-check.editDm.charLine", lang, {
      charName: targetChar.charName,
      itemLevel: Math.round(targetChar.itemLevel),
    }),
    t("raid-check.editDm.raidLine", lang, { raidLabel }),
    t("raid-check.editDm.changeLine", lang, { action: actionLine }),
  ];
  if (modeResetHappened) {
    lines.push("");
    lines.push(
      t("raid-check.editDm.modeResetNote", lang, { warnIcon: UI.icons.warn })
    );
  }
  lines.push("");
  lines.push(t("raid-check.editDm.footer", lang));

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(t("raid-check.editDm.title", lang, { doneIcon: UI.icons.done }))
    .setDescription(lines.join("\n"))
    .setTimestamp();
}

module.exports = {
  buildRaidCheckEditDMEmbed,
  getRaidCheckEditDmActionLine,
};
