/**
 * services/raid/channel-monitor-embeds.js
 * Discord embed builders used by the raid text-channel monitor.
 */

"use strict";

const { getArtistEmoji } = require("../../../models/ArtistEmoji");
const { t, tPick } = require("../../i18n");

function joinIfArray(value) {
  return Array.isArray(value) ? value.join("\n") : value;
}

function partitionRaidChannelResults(results, isReset) {
  const buckets = { done: [], already: [], notFound: [], ineligible: [], errored: [] };
  for (const result of results) {
    const display = result.displayName || result.charName;
    if (result.error) buckets.errored.push(result.charName);
    else if (result.updated) buckets.done.push(display);
    else if (isReset ? result.alreadyReset : result.alreadyComplete) buckets.already.push(display);
    else if (!result.matched) buckets.notFound.push(result.charName);
    else buckets.ineligible.push(`${display} (iLvl ${result.ineligibleItemLevel})`);
  }
  return buckets;
}

function resolveMultiResultStyle(buckets, isReset, UI) {
  const hasProgress = buckets.done.length > 0 || buckets.already.length > 0;
  const anyError = buckets.notFound.length > 0
    || buckets.ineligible.length > 0
    || buckets.errored.length > 0;
  return {
    color: hasProgress && !anyError
      ? (isReset ? UI.colors.muted : UI.colors.success)
      : UI.colors.progress,
    titleIcon: hasProgress
      ? (isReset ? UI.icons.reset : UI.icons.done)
      : UI.icons.info,
  };
}

function addNonEmptyResultFields(embed, fields) {
  embed.addFields(fields
    .filter((field) => field.count > 0)
    .map((field) => field.build()));
}

function createRaidChannelEmbedBuilders({ EmbedBuilder, UI }) {
  function buildRaidChannelMultiResultEmbed({
    results,
    raidMeta,
    gates,
    statusType,
    guildName,
    lang,
  }) {
    const isReset = statusType === "reset";
    const gatesText =
      Array.isArray(gates) && gates.length > 0
        ? gates.join(", ")
        : t("text-parser.raidUpdateAllGates", lang);
    const scopeLabel =
      statusType === "process" && Array.isArray(gates) && gates.length > 0
        ? `${raidMeta.label} · ${gatesText}`
        : raidMeta.label;
    const buckets = partitionRaidChannelResults(results, isReset);
    const style = resolveMultiResultStyle(buckets, isReset, UI);
    const embed = new EmbedBuilder()
      .setColor(style.color)
      .setTitle(`${style.titleIcon} ${t(isReset ? "text-parser.raidResetTitle" : "text-parser.raidUpdateTitle", lang, { scope: scopeLabel })}`)
      .setDescription(tPick(isReset ? "text-parser.raidResetDescription" : "text-parser.raidUpdateDescription", lang, { count: results.length }))
      .setTimestamp();
    addNonEmptyResultFields(embed, [
      {
        count: buckets.done.length,
        build: () => ({
          name: t(isReset ? "text-parser.raidResetUpdatedField" : "text-parser.raidUpdateUpdatedField", lang, {
            icon: isReset ? UI.icons.reset : UI.icons.done,
            count: buckets.done.length,
          }),
          value: buckets.done.map((name) => `**${name}**`).join(", "),
        }),
      },
      {
        count: buckets.already.length,
        build: () => ({
          name: t(isReset ? "text-parser.raidResetAlreadyField" : "text-parser.raidUpdateAlreadyField", lang, {
            icon: UI.icons.info,
            count: buckets.already.length,
          }),
          value: buckets.already.map((name) => `**${name}**`).join(", "),
        }),
      },
      {
        count: buckets.notFound.length,
        build: () => ({
          name: t("text-parser.raidUpdateNotFoundField", lang, {
            icon: UI.icons.warn,
            count: buckets.notFound.length,
          }),
          value: buckets.notFound.map((name) => `\`${name}\``).join(", "),
        }),
      },
      {
        count: buckets.ineligible.length,
        build: () => ({
          name: t("text-parser.raidUpdateIneligibleField", lang, {
            icon: UI.icons.warn,
            raidLabel: raidMeta.label,
            minItemLevel: raidMeta.minItemLevel,
          }),
          value: buckets.ineligible.join("\n"),
        }),
      },
      {
        count: buckets.errored.length,
        build: () => ({
          name: t("text-parser.raidUpdateErrorField", lang, { icon: UI.icons.warn }),
          value: buckets.errored.map((name) => `\`${name}\``).join(", "),
        }),
      },
    ]);
    if (guildName) {
      embed.setFooter({ text: t("text-parser.raidUpdateFooterServer", lang, { guildName }) });
    }
    return embed;
  }

  function buildRaidChannelWelcomeEmbed(lang) {
    return new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(t("welcome.title", lang, { icon: getArtistEmoji("shy") }).trim())
      .setDescription(joinIfArray(t("welcome.description", lang)))
      .addFields(
        { name: t("welcome.onboardingName", lang), value: joinIfArray(t("welcome.onboardingValue", lang)) },
        { name: t("welcome.examplesName", lang), value: joinIfArray(t("welcome.examplesValue", lang)) },
        { name: t("welcome.aliasesName", lang), value: joinIfArray(t("welcome.aliasesValue", lang)) },
        { name: t("welcome.notesName", lang), value: joinIfArray(t("welcome.notesValue", lang)) },
        { name: t("welcome.voiceName", lang), value: joinIfArray(t("welcome.voiceValue", lang)) },
        { name: t("welcome.maintenanceName", lang), value: joinIfArray(t("welcome.maintenanceValue", lang)) },
        { name: t("welcome.autoManageName", lang), value: joinIfArray(t("welcome.autoManageValue", lang)) },
        { name: t("welcome.sideTasksName", lang), value: joinIfArray(t("welcome.sideTasksValue", lang)) },
        { name: t("welcome.goldName", lang), value: joinIfArray(t("welcome.goldValue", lang)) },
        { name: t("welcome.iconName", lang), value: joinIfArray(t("welcome.iconValue", lang)) },
      )
      .setFooter({ text: t("welcome.footer", lang) });
  }

  return {
    buildRaidChannelMultiResultEmbed,
    buildRaidChannelWelcomeEmbed,
  };
}

module.exports = {
  createRaidChannelEmbedBuilders,
  joinIfArray,
};
