"use strict";

const {
  buildFlipPickerComponents,
} = require("../../../utils/raid/roster-picker");
const { getClassEmoji } = require("../../../models/Class");
const { parseCustomEmoji } = require("../../../utils/discord/emoji");
const {
  buildPickerClosedEmbed,
  countRoles,
  formatClassIcon,
  formatPickerCloseTime,
  formatSavedCharacterLine,
  resolveRosterIcon,
} = require("../picker/render");
const { BIBLE_ORIGIN, BIBLE_REGION } = require("../../../services/bible-endpoint");

// How a picked or skipped character reads on the card and in the dropdown.
const PICKER_STATE = Object.freeze({
  picked: { glyph: "\u2705", bold: true, optionKey: "optionSelected" },
  skipped: { glyph: "\u2b1c", bold: false, optionKey: "optionSkipped" },
});

function pickerStateOf(session, index) {
  return session.selectedIndices.has(index) ? PICKER_STATE.picked : PICKER_STATE.skipped;
}

function toIconCandidates(chars) {
  return chars.map((c) => ({ name: c.charName, className: c.className, combatScore: c.combatScore }));
}

function buildSeedRosterLink(seedCharName) {
  return `${BIBLE_ORIGIN}/character/${BIBLE_REGION}/${encodeURIComponent(seedCharName)}/roster`;
}

function createAddRosterViewBuilders({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UI,
  t,
}) {
  function buildSelectionEmbed(session) {
    const lang = session.lang;
    const pickedChars = session.chars.filter((_, index) => session.selectedIndices.has(index));
    const { supports, dps } = countRoles(pickedChars.map((c) => c.className));
    const lines = session.chars.map((c, index) => {
      const state = pickerStateOf(session, index);
      const name = state.bold ? `**${c.charName}**` : c.charName;
      return `${state.glyph} **${index + 1}.** ${formatClassIcon(c.className)} ${name} \u00b7 \`${c.itemLevel}\` \u00b7 CP \`${c.combatScore || "?"}\``;
    });
    const managerLine = session.actingForOther
      ? [t("raid-add-roster.picker.managerHelping", lang, {
        iconInfo: UI.icons.info,
        callerId: session.callerId,
        targetId: session.targetId,
      })]
      : [];

    const desc = [
      t("raid-add-roster.picker.summary", lang, {
        selected: pickedChars.length,
        total: session.chars.length,
        supports,
        dps,
      }),
      ...lines,
      "",
      ...managerLine,
      t("raid-add-roster.picker.closeLine", lang, { closeTime: formatPickerCloseTime(session.expiresAt) }),
    ];

    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.picker.title", lang, {
        rosterIcon: resolveRosterIcon(session.seedCharName, toIconCandidates(session.chars)),
        rosterName: session.seedCharName,
      }))
      .setURL(buildSeedRosterLink(session.seedCharName))
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.neutral);
  }

  function buildSelectionComponents(session) {
    return buildFlipPickerComponents({
      session,
      ActionRowBuilder,
      StringSelectMenuBuilder,
      ButtonBuilder,
      ButtonStyle,
      customIdPrefix: "add-roster",
      placeholder: t("raid-add-roster.picker.placeholder", session.lang),
      confirmLabel: t("raid-add-roster.picker.confirmLabel", session.lang, {
        count: session.selectedIndices.size,
      }),
      confirmDisabled: session.selectedIndices.size === 0,
      cancelLabel: t("raid-add-roster.picker.cancelLabel", session.lang),
      describeOption(c, index) {
        return {
          label: `${index + 1}. ${c.charName}`,
          description: t(`raid-add-roster.picker.${pickerStateOf(session, index).optionKey}`, session.lang),
          emoji: parseCustomEmoji(getClassEmoji(c.className)),
        };
      },
    });
  }

  function buildClosedEmbed(session, state) {
    return buildPickerClosedEmbed({
      EmbedBuilder,
      UI,
      t,
      keyPrefix: "raid-add-roster",
      state,
      lang: session.lang,
      vars: {
        seedName: session.seedCharName,
        link: buildSeedRosterLink(session.seedCharName),
      },
      withFooter: true,
    });
  }

  function buildExpiredEmbed(session) {
    return buildClosedEmbed(session, "expired");
  }

  function buildCancelledEmbed(session) {
    return buildClosedEmbed(session, "cancelled");
  }

  function buildSavedEmbed(session, savedAccount, dmDelivery = null) {
    const lang = session.lang;
    const link = buildSeedRosterLink(session.seedCharName);
    const summaryLines = savedAccount.characters.map((character) => formatSavedCharacterLine(character));
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
    const summaryLines = savedAccount.characters.map((character) => formatSavedCharacterLine(character));
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
  buildSeedRosterLink,
  createAddRosterViewBuilders,
};
