"use strict";

const { t } = require("../../../services/i18n");
const {
  clampEmbedTitle,
  normalizeStoredBuffer,
} = require("./library");

const RAID_BG_BROWSER_MS = 3 * 60 * 1000;

function browserMeta(variant) {
  return {
    view: { color: 0x5865f2, titleKey: "raidBg.browse.viewTitle", descKey: "raidBg.browse.viewDesc" },
    replace: { color: 0xfaa61a, titleKey: "raidBg.browse.replaceTitle", descKey: "raidBg.browse.replaceDesc" },
    delete: { color: 0xed4245, titleKey: "raidBg.browse.deleteTitle", descKey: "raidBg.browse.deleteDesc" },
  }[variant] || { color: 0x5865f2, titleKey: "raidBg.browse.viewTitle", descKey: "raidBg.browse.viewDesc" };
}

function buildSceneBrowserPayload({
  images, assignments, mode, index, variant, lang,
  AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
}) {
  const total = images.length;
  const i = Math.max(0, Math.min(Number(index) || 0, total - 1));
  const image = images[i];
  const buffer = normalizeStoredBuffer(image.imageData);
  const filename = "raid-bg-scene.jpg";
  const sizeKb = buffer?.length ? (buffer.length / 1024).toFixed(0) : "?";

  const assignedHere = (assignments || [])
    .filter((entry) => (entry.imageIndex || 0) === i)
    .map((entry) => entry.accountName || entry.accountKey)
    .filter(Boolean);

  const meta = browserMeta(variant);
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(t(meta.titleKey, lang, { index: i + 1, total }))
    .setDescription(t(meta.descKey, lang, { file: image.originalFilename || `background-${i + 1}` }))
    .setImage(`attachment://${filename}`)
    .addFields(
      {
        name: t("raidBg.browse.dimsLabel", lang),
        value: `\`${image.width || "?"}x${image.height || "?"} \u00b7 ${sizeKb} KB\``,
        inline: true,
      },
      {
        name: t("raidBg.browse.modeLabel", lang),
        value: `${t(`raidBg.set.mode.${mode || "even"}`, lang)} \u00b7 ${total}`,
        inline: true,
      },
      {
        name: t("raidBg.browse.assignedLabel", lang),
        value: assignedHere.length
          ? assignedHere.map((name) => `\`${name}\``).join(", ")
          : t("raidBg.browse.assignedNone", lang),
        inline: false,
      },
    );

  const components = [];
  if (total >= 2) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("raidbg:scene")
        .setPlaceholder(t("raidBg.browse.selectPlaceholder", lang))
        .addOptions(images.map((img, idx) => ({
          label: clampEmbedTitle(`#${idx + 1} \u00b7 ${img.originalFilename || "background"}`, 100),
          value: String(idx),
          default: idx === i,
        }))),
    ));
  }

  if (variant === "view") {
    if (total >= 2) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("raidbg:prev").setLabel("\u25c0").setStyle(ButtonStyle.Secondary).setDisabled(i === 0),
        new ButtonBuilder().setCustomId("raidbg:page").setLabel(`${i + 1}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId("raidbg:next").setLabel("\u25b6").setStyle(ButtonStyle.Secondary).setDisabled(i === total - 1),
      ));
    }
  } else if (variant === "replace") {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("raidbg:doreplace").setLabel(t("raidBg.edit.replaceBtn", lang, { index: i + 1 })).setStyle(ButtonStyle.Primary),
    ));
  } else {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("raidbg:dodelete").setLabel(t("raidBg.edit.deleteBtn", lang, { index: i + 1 })).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("raidbg:deleteall").setLabel(t("raidBg.edit.deleteAllBtn", lang)).setStyle(ButtonStyle.Secondary),
    ));
  }

  return { embeds: [embed], files: [new AttachmentBuilder(buffer, { name: filename })], components };
}

function sceneBrowserUpdatePayload(payload) {
  return {
    embeds: payload.embeds,
    files: payload.files,
    attachments: [],
    components: payload.components,
  };
}

module.exports = {
  RAID_BG_BROWSER_MS,
  buildSceneBrowserPayload,
  sceneBrowserUpdatePayload,
};
