"use strict";

const { t } = require("../../../../services/i18n");
const UserBackground = require("../../../../models/userBackground");
const {
  deferEphemeralReply,
  editEmbed,
} = require("../../../../utils/raid/common/shared");
const {
  getStoredImages,
  buildRaidBgEmbed,
} = require("../library");
const {
  RAID_BG_BROWSER_MS,
  buildSceneBrowserPayload,
  sceneBrowserUpdatePayload,
} = require("../scene-browser");

function applyViewBrowserAction({ id, values, index, imageCount }) {
  if (id === "raidbg:scene") return { handled: true, index: Number(values?.[0]) || 0 };
  if (id === "raidbg:prev") return { handled: true, index: Math.max(0, index - 1) };
  if (id === "raidbg:next") return { handled: true, index: Math.min(imageCount - 1, index + 1) };
  return { handled: false, index };
}

async function handleView({ interaction, deps, lang }) {
  const {
    AttachmentBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
  } = deps;
  await deferEphemeralReply(interaction);

  const bg = await UserBackground.findOne({ discordId: interaction.user.id }).lean();
  const images = getStoredImages(bg);
  if (images.length === 0) {
    await editEmbed(interaction, buildRaidBgEmbed(EmbedBuilder, {
      title: t("raidBg.view.noneTitle", lang),
      description: t("raidBg.view.noneDescription", lang),
      color: 0x5865f2,
    }));
    return;
  }

  let index = 0;
  const render = () => buildSceneBrowserPayload({
    images,
    assignments: bg.assignments,
    mode: bg.mode,
    index,
    variant: "view",
    lang,
    AttachmentBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
  });
  const payload = render();
  const message = await editEmbed(interaction, payload.embeds, sceneBrowserUpdatePayload(payload));

  if (images.length < 2 || !message?.createMessageComponentCollector) return;

  const collector = message.createMessageComponentCollector({ time: RAID_BG_BROWSER_MS });
  collector.on("collect", async (component) => {
    const action = applyViewBrowserAction({
      id: component.customId,
      values: component.values,
      index,
      imageCount: images.length,
    });
    if (!action.handled) return;
    index = action.index;
    const next = render();
    await component.update(sceneBrowserUpdatePayload(next));
  });
  collector.on("end", async () => {
    try { await interaction.editReply({ components: [] }); } catch { /* message gone */ }
  });
}

module.exports = {
  applyViewBrowserAction,
  handleView,
};
