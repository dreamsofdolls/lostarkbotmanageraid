"use strict";

const { t } = require("../../../services/i18n");

function buildEnableAutoDmEmbed(EmbedBuilder, { managerId, userDoc }, lang = "vi") {
  const accounts = Array.isArray(userDoc?.accounts) ? userDoc.accounts : [];
  const lastSyncAt = Number(userDoc?.lastAutoManageSyncAt) || 0;
  const hasEverSynced = lastSyncAt > 0;

  const description = [
    t("raid-auto-manage.dm.enable.description", lang, { managerId }),
    "",
    t("raid-auto-manage.dm.enable.statusLine", lang),
    t("raid-auto-manage.dm.enable.firstSyncLine", lang),
    t("raid-auto-manage.dm.enable.quickOffLine", lang),
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`\u2139\ufe0f ${t("raid-auto-manage.dm.enable.title", lang)}`)
    .setDescription(description);

  for (const account of accounts) {
    const characters = Array.isArray(account?.characters) ? account.characters : [];
    if (characters.length === 0) continue;

    const lines = characters.map((character) => {
      const name = character?.name || t("raid-auto-manage.dm.enable.charNoName", lang);
      const iLvl = Number(character?.itemLevel) || 0;
      let icon;
      let statusText;
      if (character?.publicLogDisabled === true) {
        icon = "\u{1f512}";
        statusText = t("raid-auto-manage.dm.enable.charPrivate", lang);
      } else if (hasEverSynced) {
        icon = "\u{1f513}";
        statusText = t("raid-auto-manage.dm.enable.charPublicOk", lang);
      } else {
        icon = "\u2753";
        statusText = t("raid-auto-manage.dm.enable.charUnknown", lang);
      }
      return t("raid-auto-manage.dm.enable.charLine", lang, {
        icon,
        name,
        iLvl,
        statusText,
      });
    });

    embed.addFields({
      name: t("raid-auto-manage.dm.enable.accountFieldName", lang, {
        accountName:
          account.accountName || t("raid-auto-manage.dm.enable.accountNoName", lang),
        count: characters.length,
      }),
      value: lines.join("\n").slice(0, 1024),
      inline: false,
    });
  }

  const anyUnknownOrPrivate = accounts.some((account) =>
    (account?.characters || []).some(
      (character) => character?.publicLogDisabled === true || !hasEverSynced
    )
  );
  if (anyUnknownOrPrivate) {
    embed.setFooter({
      text: t("raid-auto-manage.dm.enable.privateFooter", lang),
    });
  }

  return embed;
}

function buildDisableAutoDmEmbed(EmbedBuilder, { managerId }, lang = "vi") {
  const description = [
    t("raid-auto-manage.dm.disable.description", lang, { managerId }),
    "",
    t("raid-auto-manage.dm.disable.statusLine", lang),
    t("raid-auto-manage.dm.disable.manualSyncLine", lang),
    t("raid-auto-manage.dm.disable.quickOnLine", lang),
  ].join("\n");

  return new EmbedBuilder()
    .setColor(0x99aab5)
    .setTitle(`\u26aa ${t("raid-auto-manage.dm.disable.title", lang)}`)
    .setDescription(description);
}

module.exports = {
  buildDisableAutoDmEmbed,
  buildEnableAutoDmEmbed,
};
