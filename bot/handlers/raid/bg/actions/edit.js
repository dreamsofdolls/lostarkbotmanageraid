"use strict";

const { t } = require("../../../../services/i18n");
const UserBackground = require("../../../../models/userBackground");
const { clearBackgroundCache } = require("../../../../services/raid-card/bg-loader");
const {
  deferEphemeralReply,
  editEmbed,
} = require("../../../../utils/raid/common/shared");
const {
  RaidBgError,
  downloadAttachment,
  validateBgAttachment,
  resizeForStorage,
} = require("../image-pipeline");
const {
  RAID_BG_ASSIGNMENT_MODES,
  normalizeStoredImage,
  getStoredImages,
  buildRaidBgEmbed,
  compactAssignmentsAfterRemove,
} = require("../library");
const {
  RAID_BG_BROWSER_MS,
  buildSceneBrowserPayload,
  sceneBrowserUpdatePayload,
} = require("../scene-browser");
const { saveLibrary } = require("../persistence");

async function buildReplacementImage(attachment) {
  const buffer = await downloadAttachment(attachment);
  const validated = await validateBgAttachment(attachment, buffer);
  const resized = await resizeForStorage(validated.img);
  return {
    imageData: resized.buffer,
    mime: resized.mime,
    width: resized.width,
    height: resized.height,
    sizeBytes: resized.buffer.length,
    originalWidth: validated.width,
    originalHeight: validated.height,
    originalFilename: attachment.name || "background.jpg",
    originalMime: validated.mime || "",
    storageQuality: resized.quality,
  };
}

async function resolveReplacement({ interaction, EmbedBuilder, replaceAttachment, lang }) {
  if (!replaceAttachment) return null;
  try {
    return await buildReplacementImage(replaceAttachment);
  } catch (err) {
    if (!(err instanceof RaidBgError)) throw err;
    await editEmbed(interaction, buildRaidBgEmbed(EmbedBuilder, {
      title: t("raidBg.set.rejectTitle", lang),
      description: t(err.key, lang, err.params),
      color: 0xfee75c,
    }));
    return undefined;
  }
}

function createEditBrowserRenderer({
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  lang,
  getState,
}) {
  return () => {
    const { images, assignments, mode, index, variant } = getState();
    return buildSceneBrowserPayload({
      images,
      assignments,
      mode,
      index,
      variant,
      lang,
      AttachmentBuilder,
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      StringSelectMenuBuilder,
    });
  };
}

function createFinalNotice({ EmbedBuilder }) {
  return (component, opts) => component.update({
    embeds: [buildRaidBgEmbed(EmbedBuilder, opts)],
    files: [],
    attachments: [],
    components: [],
  });
}

function createEditActionHandlers({
  interaction,
  EmbedBuilder,
  lang,
  render,
  finalNotice,
  collector,
  getState,
  setState,
  replacement,
}) {
  const persist = async ({ images, assignments, mode }) => {
    await saveLibrary(interaction.user.id, images, assignments, mode);
    clearBackgroundCache(interaction.user.id);
  };

  return {
    "raidbg:scene": async (component) => {
      setState({ index: Number(component.values?.[0]) || 0 });
      const next = render();
      await component.update(sceneBrowserUpdatePayload(next));
    },
    "raidbg:doreplace": async (component) => {
      const { images, assignments, mode, index } = getState();
      const nextImages = images.slice();
      nextImages[index] = replacement;
      await persist({ images: nextImages, assignments, mode });
      collector.stop("done");
      await finalNotice(component, {
        title: t("raidBg.edit.replacedTitle", lang),
        description: t("raidBg.edit.replacedDescription", lang, { index: index + 1 }),
        color: 0x57f287,
      });
    },
    "raidbg:deleteall": async (component) => {
      await UserBackground.deleteOne({ discordId: interaction.user.id });
      clearBackgroundCache(interaction.user.id);
      collector.stop("done");
      await finalNotice(component, {
        title: t("raidBg.edit.clearedTitle", lang),
        description: t("raidBg.edit.clearedDescription", lang),
        color: 0x99aab5,
      });
    },
    "raidbg:dodelete": async (component) => {
      const { images, assignments, mode, index } = getState();
      if (images.length <= 1) {
        await UserBackground.deleteOne({ discordId: interaction.user.id });
        clearBackgroundCache(interaction.user.id);
        collector.stop("done");
        await finalNotice(component, {
          title: t("raidBg.edit.clearedTitle", lang),
          description: t("raidBg.edit.clearedDescription", lang),
          color: 0x99aab5,
        });
        return;
      }

      const nextImages = images.filter((_image, idx) => idx !== index);
      const nextAssignments = compactAssignmentsAfterRemove(assignments, index, nextImages.length);
      const nextIndex = index >= nextImages.length ? nextImages.length - 1 : index;
      setState({ images: nextImages, assignments: nextAssignments, index: nextIndex });
      await persist({ images: nextImages, assignments: nextAssignments, mode });
      const next = render();
      await component.update(sceneBrowserUpdatePayload(next));
    },
  };
}

async function handleEdit({ interaction, deps, lang }) {
  const {
    AttachmentBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
  } = deps;
  const replaceAttachment = interaction.options.getAttachment("image", false);
  await deferEphemeralReply(interaction);

  const bg = await UserBackground.findOne({ discordId: interaction.user.id }).lean();
  const baseImages = getStoredImages(bg);
  if (baseImages.length === 0) {
    await editEmbed(interaction, buildRaidBgEmbed(EmbedBuilder, {
      title: t("raidBg.edit.nothingTitle", lang),
      description: t("raidBg.edit.nothingDescription", lang),
      color: 0x5865f2,
    }));
    return;
  }

  const variant = replaceAttachment ? "replace" : "delete";
  const replacement = await resolveReplacement({
    interaction,
    EmbedBuilder,
    replaceAttachment,
    lang,
  });
  if (replacement === undefined) return;

  const state = {
    images: baseImages.map(normalizeStoredImage),
    assignments: (bg.assignments || []).map((entry) => ({ ...entry })),
    mode: RAID_BG_ASSIGNMENT_MODES.has(bg?.mode) ? bg.mode : "even",
    index: 0,
    variant,
  };
  const getState = () => state;
  const setState = (patch) => Object.assign(state, patch);
  const render = createEditBrowserRenderer({
    AttachmentBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    lang,
    getState,
  });
  const payload = render();
  const message = await editEmbed(interaction, payload.embeds, sceneBrowserUpdatePayload(payload));
  if (!message?.createMessageComponentCollector) return;

  const finalNotice = createFinalNotice({ EmbedBuilder });
  const collector = message.createMessageComponentCollector({ time: RAID_BG_BROWSER_MS });
  const actionHandlers = createEditActionHandlers({
    interaction,
    EmbedBuilder,
    lang,
    render,
    finalNotice,
    collector,
    getState,
    setState,
    replacement,
  });

  collector.on("collect", async (component) => {
    const handler = actionHandlers[component.customId];
    if (!handler) return;
    try {
      await handler(component);
    } catch (err) {
      console.error("[raid-bg] edit action failed:", err?.message || err);
      try {
        await finalNotice(component, {
          title: t("raidBg.set.saveFailedTitle", lang),
          description: t("raidBg.errors.storageFailed", lang, { message: err?.message || String(err) }),
          color: 0xed4245,
        });
      } catch { /* ignore */ }
    }
  });
  collector.on("end", async () => {
    try { await interaction.editReply({ components: [] }); } catch { /* message gone */ }
  });
}

module.exports = {
  buildReplacementImage,
  createEditActionHandlers,
  handleEdit,
};
