"use strict";

const { t } = require("../../../../services/i18n");
const { getRaidModeLabel } = require("../../../../utils/raid/common/labels");
const { resolveRaidCheckEditEmbedState } = require("./state");

const EMOJI = Object.freeze({
  next: "\u{1f449}",
  autoManage: "\u{1f916}",
  manualUser: "\u{1f464}",
  lockedLog: "\u{1f512}",
  sword: "\u2694\uFE0F",
  complete: "\u2705",
  process: "\u{1f4dd}",
  reset: "\u{1f504}",
  cancel: "\u2716\uFE0F",
  gateDone: "\u{1f7e2}",
  gateOtherMode: "\u{1f7e0}",
  gatePending: "\u26AA",
});

const STATUS_BUTTONS = Object.freeze([
  {
    customId: "raid-check-edit:status:complete",
    labelKey: "raid-check.editFlow.buttonComplete",
    emoji: EMOJI.complete,
    styleName: "Success",
    disabledWhen: ({ allGatesDoneAtPickedMode }) => allGatesDoneAtPickedMode,
  },
  {
    customId: "raid-check-edit:status:process",
    labelKey: "raid-check.editFlow.buttonProcess",
    emoji: EMOJI.process,
    styleName: "Primary",
    disabledWhen: ({ hasOpenGateAtPickedMode }) => !hasOpenGateAtPickedMode,
  },
  {
    customId: "raid-check-edit:status:reset",
    labelKey: "raid-check.editFlow.buttonReset",
    emoji: EMOJI.reset,
    styleName: "Danger",
    disabledWhen: () => false,
  },
]);

function createSelectRow({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  customId,
  placeholder,
  disabled,
  options,
}) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setDisabled(disabled)
      .addOptions(options)
  );
}

function createButton({ ButtonBuilder, ButtonStyle, lang, button, disabled }) {
  return new ButtonBuilder()
    .setCustomId(button.customId)
    .setLabel(t(button.labelKey, lang))
    .setEmoji(button.emoji)
    .setStyle(ButtonStyle[button.styleName])
    .setDisabled(disabled);
}

function appendSelectedRaidContext({
  description,
  state,
  lang,
  UI,
  raidRequirementMap,
  getCharRaidGateStatus,
  formatGateStateLine,
}) {
  if (!state.selectedChar || !state.selectedRaid) return;

  const raidMeta = raidRequirementMap[state.selectedRaid];
  const gateStatus = getCharRaidGateStatus(
    state.selectedChar,
    raidMeta?.raidKey,
    raidMeta?.modeKey
  );
  const gateLine = formatGateStateLine(gateStatus, raidMeta?.raidKey, lang);
  if (gateLine) {
    description.push(t("raid-check.editFlow.currentLine", lang, { value: gateLine }));
  }
  if (gateStatus?.modeChangeNeeded) {
    description.push(
      t("raid-check.editFlow.modeChangeWarn", lang, { warnIcon: UI.icons.warn })
    );
  }
  if (gateStatus?.overallStatus === "complete") {
    description.push(
      t("raid-check.editFlow.alreadyDoneInfo", lang, { infoIcon: UI.icons.info })
    );
  }
}

function buildRaidOptions({ raidRequirementMap, truncateText, lang }) {
  return Object.entries(raidRequirementMap)
    .sort(([, a], [, b]) => a.minItemLevel - b.minItemLevel)
    .slice(0, 25)
    .map(([raidKey, entry]) => ({
      label: truncateText(
        t("raid-check.editFlow.raidOptionLabel", lang, {
          label: getRaidModeLabel(entry.raidKey, entry.modeKey, lang),
          minItemLevel: entry.minItemLevel,
        }),
        100
      ),
      value: raidKey,
    }));
}

function buildUserOptions({ state, formatUserEditLabel, lang }) {
  return [...state.editableByUser.values()].slice(0, 25).map((group) => ({
    label: formatUserEditLabel(
      group,
      state.displayMap.get(group.discordId) || group.discordId,
      lang
    ),
    value: group.discordId,
    emoji: group.autoManageEnabled ? EMOJI.autoManage : EMOJI.manualUser,
    default: state.selectedUser === group.discordId,
  }));
}

function buildCharOptions({ state, formatCharEditLabel, lang }) {
  const group = state.editableByUser.get(state.selectedUser);
  return (group?.chars || []).slice(0, 25).map((char) => ({
    label: formatCharEditLabel(char, state.raidMeta, lang),
    value: `${char.accountName}||${char.charName}`,
    emoji: char.publicLogDisabled ? EMOJI.lockedLog : EMOJI.sword,
    default:
      state.selectedChar?.charName === char.charName &&
      state.selectedChar?.accountName === char.accountName,
  }));
}

function buildStatusButtonRow({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  state,
  lang,
  disabled,
  raidRequirementMap,
  getCharRaidGateStatus,
}) {
  if (!state.selectedChar) return null;

  const raidMeta = raidRequirementMap[state.selectedRaid];
  const gateStatus = getCharRaidGateStatus(
    state.selectedChar,
    raidMeta?.raidKey,
    raidMeta?.modeKey
  );
  const context = {
    allGatesDoneAtPickedMode: gateStatus?.overallStatus === "complete",
    hasOpenGateAtPickedMode: gateStatus
      ? gateStatus.gates.some((g) => !g.doneAtPickedMode)
      : true,
  };
  const buttons = STATUS_BUTTONS.map((button) =>
    createButton({
      ButtonBuilder,
      ButtonStyle,
      lang,
      button,
      disabled: disabled || button.disabledWhen(context),
    })
  );
  buttons.push(
    new ButtonBuilder()
      .setCustomId("raid-check-edit:cancel")
      .setLabel(
        state.applied
          ? t("raid-check.editFlow.buttonClose", lang)
          : t("raid-check.editFlow.buttonCancel", lang)
      )
      .setEmoji(EMOJI.cancel)
      .setStyle(ButtonStyle.Secondary)
  );
  return new ActionRowBuilder().addComponents(...buttons);
}

function resolveGateButtonStyle({ gate, ButtonStyle }) {
  if (gate.doneAtPickedMode) {
    return { emoji: EMOJI.gateDone, style: ButtonStyle.Secondary };
  }
  if (gate.doneAtSomeMode) {
    return { emoji: EMOJI.gateOtherMode, style: ButtonStyle.Primary };
  }
  return { emoji: EMOJI.gatePending, style: ButtonStyle.Primary };
}

function buildGateButtonRow({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  state,
  disabled,
  raidRequirementMap,
  getCharRaidGateStatus,
}) {
  if (!state.selectedChar || !state.awaitingGate) return null;

  const raidMeta = raidRequirementMap[state.selectedRaid];
  const gateStatus = getCharRaidGateStatus(
    state.selectedChar,
    raidMeta?.raidKey,
    raidMeta?.modeKey
  );
  const gateRow = new ActionRowBuilder();
  for (const gate of (gateStatus?.gates || []).slice(0, 5)) {
    const { emoji, style } = resolveGateButtonStyle({ gate, ButtonStyle });
    gateRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`raid-check-edit:gate:${gate.gate}`)
        .setLabel(gate.gate)
        .setDisabled(disabled || gate.doneAtPickedMode)
        .setEmoji(emoji)
        .setStyle(style)
    );
  }
  return gateRow.components.length > 0 ? gateRow : null;
}

function createRaidCheckEditRenderer({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  truncateText,
  RAID_REQUIREMENT_MAP,
  getCharRaidGateStatus,
  formatGateStateLine,
  formatCharEditLabel,
  formatUserEditLabel,
  RAID_CHECK_EDIT_SESSION_MS,
}) {
  function buildEditEmbed(state) {
    const lang = state.lang || "vi";
    const {
      nextStep,
      userLabel,
      charLabel,
      raidLabel,
      headerLine,
      raidLineSuffix,
    } = resolveRaidCheckEditEmbedState({
      state,
      raidRequirementMap: RAID_REQUIREMENT_MAP,
      lang,
    });

    const description = [
      headerLine,
      "",
      t("raid-check.editFlow.userLine", lang, { value: userLabel }),
      t("raid-check.editFlow.charLine", lang, { value: charLabel }),
      t("raid-check.editFlow.raidLine", lang, {
        value: raidLabel,
        suffix: raidLineSuffix,
      }),
    ];
    appendSelectedRaidContext({
      description,
      state,
      lang,
      UI,
      raidRequirementMap: RAID_REQUIREMENT_MAP,
      getCharRaidGateStatus,
      formatGateStateLine,
    });
    description.push("");
    description.push(`${EMOJI.next} ${nextStep}`);

    if (state.selectedChar?.autoManageEnabled && state.selectedChar?.publicLogDisabled) {
      description.push("");
      description.push(
        t("raid-check.editFlow.autoSyncLogOffNote", lang, { warnIcon: UI.icons.warn })
      );
    }

    const embed = new EmbedBuilder()
      .setTitle(t("raid-check.editFlow.title", lang))
      .setColor(state.applied ? UI.colors.success : UI.colors.neutral)
      .setDescription(description.join("\n"));

    if (state.applied && state.message) {
      embed.addFields({
        name: t("raid-check.editFlow.resultFieldName", lang),
        value: state.message,
      });
    }
    if (!state.applied && state.warning) {
      embed.addFields({
        name: t("raid-check.editFlow.noteFieldName", lang),
        value: state.warning,
      });
    }

    embed.setFooter({
      text: t("raid-check.editFlow.footerActive", lang, {
        minutes: RAID_CHECK_EDIT_SESSION_MS / 60_000,
      }),
    });
    return embed;
  }

  function buildEditComponents(state) {
    const lang = state.lang || "vi";
    const rows = [];
    const disabled = state.applied || state.locked;

    if (state.scopeAll) {
      const raidOptions = buildRaidOptions({
        raidRequirementMap: RAID_REQUIREMENT_MAP,
        truncateText,
        lang,
      }).map((option) => ({
        ...option,
        default: state.selectedRaid === option.value,
      }));
      rows.push(
        createSelectRow({
          ActionRowBuilder,
          StringSelectMenuBuilder,
          customId: "raid-check-edit:raid",
          placeholder: t("raid-check.editFlow.raidPickerPlaceholder", lang),
          disabled,
          options: raidOptions,
        })
      );
    }

    if (state.scopeAll && !state.raidMeta) return rows;

    const userOptions = buildUserOptions({ state, formatUserEditLabel, lang });
    if (userOptions.length > 0) {
      rows.push(
        createSelectRow({
          ActionRowBuilder,
          StringSelectMenuBuilder,
          customId: "raid-check-edit:user",
          placeholder: t("raid-check.editFlow.userPickerPlaceholder", lang),
          disabled,
          options: userOptions,
        })
      );
    }

    if (state.selectedUser) {
      const charOptions = buildCharOptions({ state, formatCharEditLabel, lang });
      if (charOptions.length > 0) {
        rows.push(
          createSelectRow({
            ActionRowBuilder,
            StringSelectMenuBuilder,
            customId: "raid-check-edit:char",
            placeholder: t("raid-check.editFlow.charPickerPlaceholder", lang),
            disabled,
            options: charOptions,
          })
        );
      }
    }

    const statusRow = buildStatusButtonRow({
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      state,
      lang,
      disabled,
      raidRequirementMap: RAID_REQUIREMENT_MAP,
      getCharRaidGateStatus,
    });
    if (statusRow) rows.push(statusRow);

    const gateRow = buildGateButtonRow({
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      state,
      disabled,
      raidRequirementMap: RAID_REQUIREMENT_MAP,
      getCharRaidGateStatus,
    });
    if (gateRow) rows.push(gateRow);

    return rows;
  }

  return {
    buildEditEmbed,
    buildEditComponents,
  };
}

module.exports = {
  createRaidCheckEditRenderer,
};
