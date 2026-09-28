"use strict";

const { t } = require("../../../services/i18n");
const { INLINE_SPACER } = require("../../../utils/raid/common/shared");

// Discord's caps on one embed: 25 fields and 6000 characters in all.
const EMBED_MAX_FIELDS = 25;
const EMBED_MAX_LENGTH = 6000;

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

  const title = `\u2139\ufe0f ${t("raid-auto-manage.dm.enable.title", lang)}`;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(description);

  const rosterFields = [];
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

    rosterFields.push({
      field: {
        name: t("raid-auto-manage.dm.enable.accountFieldName", lang, {
          accountName:
            account.accountName || t("raid-auto-manage.dm.enable.accountNoName", lang),
          count: characters.length,
        }),
        value: lines.join("\n").slice(0, 1024),
        inline: false,
      },
      characterCount: characters.length,
    });
  }

  const anyUnknownOrPrivate = accounts.some((account) =>
    (account?.characters || []).some(
      (character) => character?.publicLogDisabled === true || !hasEverSynced
    )
  );
  const footer = anyUnknownOrPrivate ? t("raid-auto-manage.dm.enable.privateFooter", lang) : "";
  if (footer) embed.setFooter({ text: footer });

  // A Manager can enable auto-sync for a roster too large for one embed: keep
  // the first rosters that fit and count the other characters in a last field.
  const fieldLength = ({ name, value }) => name.length + value.length;
  const moreField = (count) => ({
    name: INLINE_SPACER.name,
    value: t("raid-status.embed.moreCharacters", lang, { n: count }),
    inline: false,
  });
  const fieldsFor = (shown) => {
    const kept = rosterFields.slice(0, shown).map((entry) => entry.field);
    const leftOut = rosterFields.slice(shown).reduce((sum, entry) => sum + entry.characterCount, 0);
    return leftOut > 0 ? [...kept, moreField(leftOut)] : kept;
  };
  const baseLength = title.length + description.length + footer.length;
  const fits = (fields) => fields.length <= EMBED_MAX_FIELDS
    && baseLength + fields.reduce((sum, field) => sum + fieldLength(field), 0) <= EMBED_MAX_LENGTH;
  let shown = rosterFields.length;
  while (shown > 0 && !fits(fieldsFor(shown))) shown -= 1;
  const fields = fieldsFor(shown);
  if (fields.length > 0) embed.addFields(...fields);

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
