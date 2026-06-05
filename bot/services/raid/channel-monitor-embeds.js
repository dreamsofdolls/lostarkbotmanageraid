/**
 * services/raid/channel-monitor-embeds.js
 * Discord embed builders used by the raid text-channel monitor.
 */

"use strict";

const { getArtistEmoji } = require("../../models/ArtistEmoji");
const { t } = require("../i18n");

function joinIfArray(value) {
  return Array.isArray(value) ? value.join("\n") : value;
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
    const gatesText =
      Array.isArray(gates) && gates.length > 0
        ? gates.join(", ")
        : t("text-parser.raidUpdateAllGates", lang);
    const scopeLabel =
      statusType === "process" && Array.isArray(gates) && gates.length > 0
        ? `${raidMeta.label} · ${gatesText}`
        : raidMeta.label;
    const done = [];
    const already = [];
    const notFound = [];
    const ineligible = [];
    const errored = [];
    for (const result of results) {
      const display = result.displayName || result.charName;
      if (result.error) errored.push(result.charName);
      else if (result.updated) done.push(display);
      else if (result.alreadyComplete) already.push(display);
      else if (!result.matched) notFound.push(result.charName);
      else ineligible.push(`${display} (iLvl ${result.ineligibleItemLevel})`);
    }

    const hasProgress = done.length > 0 || already.length > 0;
    const anyError = notFound.length > 0 || ineligible.length > 0 || errored.length > 0;
    const color = hasProgress && !anyError ? UI.colors.success : UI.colors.progress;
    const titleIcon = hasProgress ? UI.icons.done : UI.icons.info;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${titleIcon} ${t("text-parser.raidUpdateTitle", lang, { scope: scopeLabel })}`)
      .setDescription(t("text-parser.raidUpdateDescription", lang, { count: results.length }))
      .setTimestamp();

    if (done.length > 0) {
      embed.addFields({
        name: t("text-parser.raidUpdateUpdatedField", lang, {
          icon: UI.icons.done,
          count: done.length,
        }),
        value: done.map((name) => `**${name}**`).join(", "),
      });
    }
    if (already.length > 0) {
      embed.addFields({
        name: t("text-parser.raidUpdateAlreadyField", lang, {
          icon: UI.icons.info,
          count: already.length,
        }),
        value: already.map((name) => `**${name}**`).join(", "),
      });
    }
    if (notFound.length > 0) {
      embed.addFields({
        name: t("text-parser.raidUpdateNotFoundField", lang, {
          icon: UI.icons.warn,
          count: notFound.length,
        }),
        value: notFound.map((name) => `\`${name}\``).join(", "),
      });
    }
    if (ineligible.length > 0) {
      embed.addFields({
        name: t("text-parser.raidUpdateIneligibleField", lang, {
          icon: UI.icons.warn,
          raidLabel: raidMeta.label,
          minItemLevel: raidMeta.minItemLevel,
        }),
        value: ineligible.join("\n"),
      });
    }
    if (errored.length > 0) {
      embed.addFields({
        name: t("text-parser.raidUpdateErrorField", lang, { icon: UI.icons.warn }),
        value: errored.map((name) => `\`${name}\``).join(", "),
      });
    }
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
        { name: t("welcome.crownName", lang), value: joinIfArray(t("welcome.crownValue", lang)) },
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
