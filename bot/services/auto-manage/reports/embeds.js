"use strict";

const { t } = require("../../i18n");
const { getRaidLabel, getModeLabel } = require("../../../utils/raid/common/labels");
const { splitEmbedFieldValue } = require("../../../utils/raid/common/shared");

function addChunkedEmbedField(embed, name, value) {
  const chunks = splitEmbedFieldValue(value);
  chunks.forEach((chunk, index) => {
    embed.addFields({
      name: index === 0 ? name : `${name} (${index + 1})`,
      value: chunk,
      inline: false,
    });
  });
}

function createAutoManageReportEmbeds({ EmbedBuilder, UI }) {
  function buildAutoManageHiddenCharsWarningEmbed(hiddenChars, probeReport, lang = "vi") {
    const visibleApplied = (probeReport?.perChar || []).filter(
      (c) => !c.error && Array.isArray(c.applied) && c.applied.length > 0
    );
    const lines = hiddenChars
      .slice(0, 20)
      .map((c) =>
        t("raid-auto-manage.hiddenWarning.charLine", lang, { name: c.charName || "?" }),
      );
    const extra =
      hiddenChars.length > 20
        ? `\n${t("raid-auto-manage.hiddenWarning.charsExtra", lang, {
            n: hiddenChars.length - 20,
          })}`
        : "";

    const description = [
      t("raid-auto-manage.hiddenWarning.descriptionLine1", lang, {
        hidden: hiddenChars.length,
        total: (probeReport?.perChar || []).length,
      }),
      "",
      t("raid-auto-manage.hiddenWarning.charsBlockHeader", lang),
      `${lines.join("\n")}${extra}`,
    ].join("\n");

    const embed = new EmbedBuilder()
      .setColor(UI.colors.progress)
      .setTitle(`${UI.icons.warn} ${t("raid-auto-manage.hiddenWarning.title", lang)}`)
      .setDescription(description)
      .setTimestamp();

    if (visibleApplied.length > 0) {
      const applicableLines = visibleApplied
        .slice(0, 10)
        .map((c) =>
          t("raid-auto-manage.hiddenWarning.applicableLine", lang, {
            name: c.charName,
            n: c.applied.length,
          }),
        );
      const applicableExtra =
        visibleApplied.length > 10
          ? `\n${t("raid-auto-manage.hiddenWarning.applicableExtra", lang, {
              n: visibleApplied.length - 10,
            })}`
          : "";
      embed.addFields({
        name: t("raid-auto-manage.hiddenWarning.applicableHeader", lang),
        value: applicableLines.join("\n") + applicableExtra,
        inline: false,
      });
    }

    embed.addFields({
      name: t("raid-auto-manage.hiddenWarning.optionsHeader", lang),
      value: [
        t("raid-auto-manage.hiddenWarning.optionConfirm", lang),
        t("raid-auto-manage.hiddenWarning.optionCancel", lang),
        t("raid-auto-manage.hiddenWarning.optionTimeout", lang),
      ].join("\n"),
      inline: false,
    });

    return embed;
  }

  function buildAutoManageSyncReportEmbed(report, lang = "vi") {
    const appliedTotal = report?.appliedTotal || 0;
    const perChar = Array.isArray(report?.perChar) ? report.perChar : [];
    const errored = perChar.filter((c) => c.error);
    const withApplied = perChar.filter((c) => c.applied.length > 0);
    const allFailed = perChar.length > 0 && errored.length === perChar.length;

    let description;
    if (appliedTotal > 0) {
      description = t("raid-auto-manage.syncReport.descriptionApplied", lang, {
        n: appliedTotal,
      });
      if (errored.length > 0) {
        description += `\n${t("raid-auto-manage.syncReport.descriptionAppliedFailsTail", lang, {
          warnIcon: UI.icons.warn,
          n: errored.length,
        })}`;
      }
    } else if (allFailed) {
      description = t("raid-auto-manage.syncReport.descriptionAllFailed", lang, {
        n: errored.length,
      });
    } else if (errored.length > 0) {
      description = t("raid-auto-manage.syncReport.descriptionNoNewWithFails", lang, {
        warnIcon: UI.icons.warn,
        failed: errored.length,
        total: perChar.length,
      });
    } else {
      description = t("raid-auto-manage.syncReport.descriptionNoNew", lang);
    }

    const embed = new EmbedBuilder()
      .setColor(
        appliedTotal > 0
          ? UI.colors.success
          : allFailed
            ? UI.colors.progress
            : UI.colors.neutral
      )
      .setTitle(
        `${appliedTotal > 0 ? UI.icons.done : UI.icons.info} ${t(
          "raid-auto-manage.syncReport.title",
          lang,
        )}`,
      )
      .setDescription(description)
      .setTimestamp();

    for (const c of withApplied.slice(0, 10)) {
      const lines = c.applied.map((a) =>
        t("raid-auto-manage.syncReport.appliedLine", lang, {
          raidLabel: a.raidKey ? getRaidLabel(a.raidKey, lang) : a.raidLabel,
          gate: a.gate,
          difficulty: a.modeKey ? getModeLabel(a.modeKey, lang) : a.difficulty,
        }),
      );
      embed.addFields({
        name: t("raid-auto-manage.syncReport.appliedFieldName", lang, {
          icon: UI.icons.done,
          charName: c.charName,
          accountName: c.accountName,
        }),
        value: lines.join("\n"),
        inline: false,
      });
    }
    if (withApplied.length > 10) {
      embed.addFields({
        name: t("raid-auto-manage.syncReport.moreCharsHeader", lang),
        value: t("raid-auto-manage.syncReport.moreCharsBody", lang, {
          n: withApplied.length - 10,
        }),
      });
    }

    if (errored.length > 0) {
      const MAX_ERROR_LINE = 180;
      const DISPLAY_LIMIT = 10;
      const lines = errored.slice(0, DISPLAY_LIMIT).map((c) => {
        const raw = `\`${c.charName}\`: ${c.error}`;
        return raw.length > MAX_ERROR_LINE
          ? `${raw.slice(0, MAX_ERROR_LINE - 1)}\u2026`
          : raw;
      });
      if (errored.length > DISPLAY_LIMIT) {
        lines.push(
          t("raid-auto-manage.syncReport.failsExtra", lang, {
            n: errored.length - DISPLAY_LIMIT,
          }),
        );
      }
      addChunkedEmbedField(
        embed,
        t("raid-auto-manage.syncReport.failsHeader", lang, {
          warnIcon: UI.icons.warn,
          count: errored.length,
        }),
        lines.join("\n")
      );
    }

    return embed;
  }

  return {
    buildAutoManageHiddenCharsWarningEmbed,
    buildAutoManageSyncReportEmbed,
  };
}

module.exports = {
  addChunkedEmbedField,
  createAutoManageReportEmbeds,
};
