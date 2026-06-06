"use strict";

const {
  buildTogglePickerComponents,
} = require("../../../utils/raid/roster-picker");

const CHECK_ICON = "\u2705";
const UNCHECK_ICON = "\u2b1c";
const BUTTONS_PER_ROW = 5;

function buildSeedRosterLink(seedCharName) {
  return `https://lostark.bible/character/NA/${encodeURIComponent(seedCharName)}/roster`;
}

function createAddRosterViewBuilders({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  t,
}) {
  function buildSelectionEmbed(session) {
    const lang = session.lang;
    const link = buildSeedRosterLink(session.seedCharName);
    const lines = session.chars.map((c, i) => {
      const cp = c.combatScore || "?";
      return `**${i + 1}.** ${c.charName} \u00b7 ${c.className} \u00b7 iLvl \`${c.itemLevel}\` \u00b7 CP \`${cp}\``;
    });

    const desc = [
      t("raid-add-roster.picker.rosterLine", lang, {
        seedName: session.seedCharName,
        link,
      }),
      t("raid-add-roster.picker.foundLine", lang, { count: session.chars.length }),
      "",
      ...lines,
      "",
      t("raid-add-roster.picker.selectingLine", lang, {
        selected: session.selectedIndices.size,
        total: session.chars.length,
      }),
      t("raid-add-roster.picker.footerHint", lang, { iconInfo: UI.icons.info }),
    ];

    if (session.actingForOther) {
      desc.push("");
      desc.push(
        t("raid-add-roster.picker.managerHelping", lang, {
          iconInfo: UI.icons.info,
          callerId: session.callerId,
          targetId: session.targetId,
        })
      );
    }

    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.picker.title", lang, { iconRoster: UI.icons.roster }))
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.neutral)
      .setFooter({ text: t("raid-add-roster.picker.footerText", lang) });
  }

  function buildSelectionComponents(session) {
    return buildTogglePickerComponents({
      session,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      buttonsPerRow: BUTTONS_PER_ROW,
      customIdPrefix: "add-roster",
      confirmLabel: `Confirm (${session.selectedIndices.size})`,
      confirmDisabled: session.selectedIndices.size === 0,
      cancelLabel: t("raid-add-roster.picker.cancelLabel", session.lang),
      describeButton(c, index) {
        const isSelected = session.selectedIndices.has(index);
        const marker = isSelected ? CHECK_ICON : UNCHECK_ICON;
        return {
          selected: isSelected,
          label: `${marker} ${index + 1}. ${c.charName} (${c.className})`,
        };
      },
    });
  }

  function buildExpiredEmbed(session) {
    const lang = session.lang;
    const link = buildSeedRosterLink(session.seedCharName);
    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.expired.title", lang, { iconWarn: UI.icons.warn }))
      .setDescription(
        t("raid-add-roster.expired.description", lang, {
          seedName: session.seedCharName,
          link,
        })
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: t("raid-add-roster.expired.footerText", lang) });
  }

  function buildCancelledEmbed(session) {
    const lang = session.lang;
    const link = buildSeedRosterLink(session.seedCharName);
    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.cancelled.title", lang, { iconInfo: UI.icons.info }))
      .setDescription(
        t("raid-add-roster.cancelled.description", lang, {
          seedName: session.seedCharName,
          link,
        })
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: t("raid-add-roster.cancelled.footerText", lang) });
  }

  function buildSavedEmbed(session, savedAccount, dmDelivery = null) {
    const lang = session.lang;
    const link = buildSeedRosterLink(session.seedCharName);
    const summaryLines = savedAccount.characters.map(
      (character, index) =>
        `${index + 1}. ${character.name} \u00b7 ${character.class} \u00b7 \`${character.itemLevel}\` \u00b7 \`${character.combatScore || "?"}\``
    );
    const descriptionLines = [
      t("raid-add-roster.saved.rosterLine", lang, {
        accountName: savedAccount.accountName,
        link,
      }),
      t("raid-add-roster.saved.savedLine", lang, {
        count: savedAccount.characters.length,
      }),
    ];
    if (session.actingForOther) {
      descriptionLines.push(
        t("raid-add-roster.saved.managerHelpingLine", lang, {
          iconInfo: UI.icons.info,
          callerId: session.callerId,
          targetId: session.targetId,
        })
      );
      if (dmDelivery?.delivered) {
        descriptionLines.push(
          t("raid-add-roster.saved.dmDelivered", lang, { targetId: session.targetId })
        );
      } else if (dmDelivery?.reason === "dms-disabled") {
        descriptionLines.push(
          t("raid-add-roster.saved.dmDisabled", lang, {
            iconWarn: UI.icons.warn,
            targetId: session.targetId,
          })
        );
      } else if (dmDelivery?.reason === "error") {
        descriptionLines.push(
          t("raid-add-roster.saved.dmError", lang, {
            iconWarn: UI.icons.warn,
            targetId: session.targetId,
          })
        );
      }
    }
    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.saved.title", lang, { iconRoster: UI.icons.roster }))
      .setDescription(descriptionLines.join("\n"))
      .addFields({
        name: t("raid-add-roster.saved.charactersField", lang, {
          count: savedAccount.characters.length,
        }),
        value: summaryLines.join("\n").slice(0, 1024),
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: t("raid-add-roster.saved.footerText", lang) })
      .setTimestamp();
  }

  function buildTargetDMEmbed(session, savedAccount, guildName, targetLang) {
    const lang = targetLang;
    const link = buildSeedRosterLink(session.seedCharName);
    const summaryLines = savedAccount.characters.map(
      (character, index) =>
        `${index + 1}. ${character.name} \u00b7 ${character.class} \u00b7 \`${character.itemLevel}\` \u00b7 \`${character.combatScore || "?"}\``
    );
    const guildLine = guildName
      ? t("raid-add-roster.targetDM.guildLine", lang, { guildName })
      : "";
    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.targetDM.title", lang, { iconRoster: UI.icons.roster }))
      .setDescription(
        t("raid-add-roster.targetDM.description", lang, {
          callerId: session.callerId,
          guildLine,
          accountName: savedAccount.accountName,
          link,
          count: savedAccount.characters.length,
        })
      )
      .addFields({
        name: t("raid-add-roster.targetDM.charactersField", lang, {
          count: savedAccount.characters.length,
        }),
        value: summaryLines.join("\n").slice(0, 1024),
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: t("raid-add-roster.targetDM.footerText", lang) })
      .setTimestamp();
  }

  return {
    buildCancelledEmbed,
    buildExpiredEmbed,
    buildSavedEmbed,
    buildSeedRosterLink,
    buildSelectionComponents,
    buildSelectionEmbed,
    buildTargetDMEmbed,
  };
}

module.exports = {
  BUTTONS_PER_ROW,
  CHECK_ICON,
  UNCHECK_ICON,
  buildSeedRosterLink,
  createAddRosterViewBuilders,
};
