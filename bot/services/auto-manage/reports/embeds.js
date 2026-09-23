"use strict";

// tPick, not t: the sync-report descriptions are variant pools, and every
// other key this module resolves passes straight through to t().
const { tPick: t } = require("../../i18n");
const {
  formatAutoManageFreshnessLine,
  formatNextCooldownRemaining,
  formatProgressTotals,
  getCharacterName,
} = require("../../../utils/raid/common/shared");
const {
  getStatusRaidsForCharacter,
  isCountedRaidFilterProgress,
  summarizeRaidProgress,
} = require("../../../utils/raid/common/character");
const {
  BLANK_FIELD_VALUE,
  appendGroupFields,
  buildCharacterStatusField,
  touchedRaidLines,
} = require("../../../utils/raid/common/changed-characters");
const { BIBLE_ERROR_KIND } = require("../bible/error-kinds");
const { describeBibleError } = require("../bible/error-text");

const MAX_REASON_NAMES = 10;
// What the user can fix first, then what waits on Bible, then the rest.
const REASON_ORDER = [
  BIBLE_ERROR_KIND.publicLogOff,
  BIBLE_ERROR_KIND.notFound,
  BIBLE_ERROR_KIND.blocked,
  BIBLE_ERROR_KIND.rateLimit,
  BIBLE_ERROR_KIND.other,
];

/**
 * Report embeds for Bible auto-sync.
 * @param {object} deps
 * @param {Function} deps.EmbedBuilder - discord.js builder
 * @param {object} deps.UI - shared color and icon palette
 * @param {Function} deps.getAutoManageCooldownMs - cooldown for a discordId
 * @returns {object} the embed builders
 */
function createAutoManageReportEmbeds({
  EmbedBuilder,
  UI,
  getAutoManageCooldownMs,
}) {
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

  function resolveSyncOutcome(perChar, appliedTotal) {
    const failed = perChar.filter((entry) => entry.error).length;
    if (perChar.length > 0 && failed === perChar.length) {
      return { key: "allFailed", icon: UI.icons.warn, color: UI.colors.danger, failed };
    }
    if (failed > 0) {
      return {
        key: appliedTotal > 0 ? "appliedWithFails" : "noNewWithFails",
        icon: UI.icons.warn,
        color: UI.colors.progress,
        failed,
      };
    }
    if (appliedTotal > 0) return { key: "applied", icon: UI.icons.done, color: UI.colors.success, failed };
    return { key: "noNew", icon: UI.icons.info, color: UI.colors.neutral, failed };
  }

  function describeOutcome(outcome, perChar, appliedTotal, lang) {
    switch (outcome.key) {
      case "applied":
        return t("raid-auto-manage.syncReport.descriptionApplied", lang, { n: appliedTotal });
      case "appliedWithFails":
        return [
          t("raid-auto-manage.syncReport.descriptionApplied", lang, { n: appliedTotal }),
          t("raid-auto-manage.syncReport.descriptionAppliedFailsTail", lang, {
            warnIcon: UI.icons.warn,
            n: outcome.failed,
          }),
        ].join("\n");
      case "noNewWithFails":
        return t("raid-auto-manage.syncReport.descriptionNoNewWithFails", lang, {
          warnIcon: UI.icons.warn,
          failed: outcome.failed,
          total: perChar.length,
        });
      case "allFailed":
        return t("raid-auto-manage.syncReport.descriptionAllFailed", lang, { n: outcome.failed });
      default:
        return t("raid-auto-manage.syncReport.descriptionNoNew", lang);
    }
  }

  function formatFailureRow(failure) {
    return failure.kind === BIBLE_ERROR_KIND.other
      ? `${UI.icons.warn} \`${failure.text}\``
      : `${UI.icons.warn} _${failure.text}_`;
  }

  function buildReasonLines(perChar, lang) {
    const groups = new Map(REASON_ORDER.map((kind) => [kind, { names: [], texts: new Set() }]));
    for (const entry of perChar) {
      const failure = describeBibleError(entry.error, lang);
      const group = groups.get(failure.kind);
      group.names.push(entry.charName);
      group.texts.add(failure.text);
    }
    const lines = [];
    for (const [kind, group] of groups) {
      if (group.names.length === 0) continue;
      const shown = group.names.slice(0, MAX_REASON_NAMES).map((name) => `**${name}**`).join(", ");
      const hidden = group.names.length - MAX_REASON_NAMES;
      const more = hidden > 0 ? ` ${t("raid-auto-manage.syncReport.moreNames", lang, { n: hidden })}` : "";
      const isOther = kind === BIBLE_ERROR_KIND.other;
      // The error text is printed once, and only when the whole group shares it.
      const sample = isOther && group.texts.size === 1 ? ` \u00b7 \`${[...group.texts][0]}\`` : "";
      const reason = isOther
        ? t("raid-auto-manage.syncReport.otherError", lang)
        : [...group.texts][0];
      lines.push(`${t("raid-auto-manage.syncReport.reasonLine", lang, {
        warnIcon: UI.icons.warn,
        reason,
        names: `${shown}${more}`,
      })}${sample}`);
    }
    return lines;
  }

  function buildFreshnessLine(userDoc, lang) {
    const lastAttemptAt = Number(userDoc.lastAutoManageAttemptAt) || 0;
    const cooldownMs = getAutoManageCooldownMs(userDoc.discordId);
    const readyAt = formatNextCooldownRemaining(lastAttemptAt, cooldownMs)
      ? lastAttemptAt + cooldownMs
      : 0;
    return formatAutoManageFreshnessLine({
      lastSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
      readyAt,
    }, UI, lang);
  }

  // Same counting as the unfiltered /raid-status footer, over the user's
  // own rosters (Bible sync never touches shared ones).
  function buildProgressFooter(userDoc, lang) {
    const counted = [];
    for (const account of userDoc.accounts || []) {
      for (const character of account.characters || []) {
        counted.push(...getStatusRaidsForCharacter(character).filter(isCountedRaidFilterProgress));
      }
    }
    const { completed, partial, total } = summarizeRaidProgress(counted);
    return formatProgressTotals(
      { done: completed, partial, pending: Math.max(0, total - completed - partial) },
      UI,
      lang,
    );
  }

  function buildCharacterGroups(perChar, userDoc, lang) {
    const entryFor = new Map(perChar.map((entry) => [
      `${entry.accountName}::${String(entry.charName || "").toLowerCase()}`,
      entry,
    ]));
    const groups = [];
    for (const account of userDoc.accounts || []) {
      const charFields = [];
      for (const character of account.characters || []) {
        const entry = entryFor.get(
          `${account.accountName}::${String(getCharacterName(character) || "").toLowerCase()}`
        );
        if (!entry) continue;
        const lines = entry.error
          ? [formatFailureRow(describeBibleError(entry.error, lang))]
          : touchedRaidLines(
            character,
            new Set(entry.applied.map((gate) => `${gate.raidKey}::${gate.modeKey}`)),
            lang,
          );
        if (lines.length > 0) charFields.push(buildCharacterStatusField(character, lines));
      }
      if (charFields.length > 0) groups.push({ account, charFields });
    }
    return groups;
  }

  /**
   * The report card of a Bible sync (`action:sync`, and the first sync of
   * `action:on`), with characters in the /raid-status grammar.
   * @param {{appliedTotal: number, perChar: object[]}} report - applyAutoManageCollected report
   * @param {string} lang - locale
   * @param {object} options
   * @param {object} options.userDoc - the user document as the sync saved it
   * @param {string} [options.titleText] - title text in place of the report title
   * @returns {EmbedBuilder}
   */
  function buildAutoManageSyncReportEmbed(report, lang, { userDoc, titleText }) {
    const { appliedTotal, perChar } = report;
    const outcome = resolveSyncOutcome(perChar, appliedTotal);
    const descriptionLines = [
      describeOutcome(outcome, perChar, appliedTotal, lang),
      buildFreshnessLine(userDoc, lang),
      ...(outcome.key === "allFailed" ? buildReasonLines(perChar, lang) : []),
    ];

    const embed = new EmbedBuilder()
      .setColor(outcome.color)
      .setTitle(`${outcome.icon} ${titleText || t("raid-auto-manage.syncReport.title", lang)}`)
      .setDescription(descriptionLines.join("\n"))
      .setFooter({ text: buildProgressFooter(userDoc, lang) })
      .setTimestamp();

    // When every character failed, the reason lines say it once; a card per
    // character would repeat one row and could pass the field cap.
    if (outcome.key === "allFailed") return embed;

    const groups = buildCharacterGroups(perChar, userDoc, lang);
    const fields = [];
    for (const group of groups) {
      // Same rule as the Local Sync card: a roster header only when more
      // than one roster has cards.
      const header = groups.length > 1 ? {
        name: `${UI.icons.folder} ${group.account.accountName || "?"} (${group.charFields.length})`,
        value: BLANK_FIELD_VALUE,
        inline: false,
      } : null;
      appendGroupFields(fields, header, group.charFields);
    }
    if (fields.length > 0) embed.addFields(...fields);
    return embed;
  }

  return {
    buildAutoManageHiddenCharsWarningEmbed,
    buildAutoManageSyncReportEmbed,
  };
}

module.exports = {
  createAutoManageReportEmbeds,
};
