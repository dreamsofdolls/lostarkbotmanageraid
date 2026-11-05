"use strict";

const { t } = require("../../../../services/i18n");
const UserBackground = require("../../../../models/userBackground");
const { clearBackgroundCache } = require("../../../../services/raid-card/bg-loader");
const {
  NoticeKind,
  buildNoRosterNotice,
  deferEphemeralReply,
  editEmbed,
  editNotice,
  UI,
} = require("../../../../utils/raid/common/shared");
const {
  RaidBgError,
  RAID_BG_OUTPUT_WIDTH,
  RAID_BG_OUTPUT_HEIGHT,
  processBgAttachment,
} = require("../image-pipeline");
const { buildSaveFailedNotice, buildUploadErrorNotice } = require("../notices");
const {
  RAID_BG_MAX_IMAGES,
  RAID_BG_ASSIGNMENT_MODES,
  collectAttachments,
  buildAssignments,
  loadVisibleRosterNames,
  normalizeStoredImage,
  getStoredImages,
  formatAssignmentLines,
  formatImageSlotLines,
  buildImagePreviewEmbeds,
  buildRaidBgEmbed,
} = require("../library");
const { upsertLibrary } = require("../persistence");

function resolveSetAction(interaction) {
  const actionOption = interaction.options.getString("action", false);
  return actionOption === "extend" ? "extend" : "overwrite";
}

function resolveSetMode({ modeOption, existing }) {
  if (RAID_BG_ASSIGNMENT_MODES.has(modeOption)) return modeOption;
  if (RAID_BG_ASSIGNMENT_MODES.has(existing?.mode)) return existing.mode;
  return "even";
}

async function processUploads(attachments) {
  const processed = [];
  for (const attachment of attachments) {
    processed.push(await processBgAttachment(
      attachment,
      `background-${processed.length + 1}.png`,
    ));
  }
  return processed;
}

function buildSetSuccessFields({ images, assignments, mode, lang }) {
  const totalKb = images.reduce((sum, image) => sum + image.sizeBytes, 0) / 1024;
  const assignmentLines = formatAssignmentLines(assignments);
  const slotLines = formatImageSlotLines(images);
  const fields = [
    {
      name: t("raidBg.set.imagesLabel", lang),
      value: t("raidBg.set.imagesValue", lang, {
        count: images.length,
        totalKb: totalKb.toFixed(0),
        max: RAID_BG_MAX_IMAGES,
      }),
      inline: true,
    },
    {
      name: t("raidBg.set.modeLabel", lang),
      value: t(`raidBg.set.mode.${mode}`, lang),
      inline: true,
    },
    {
      name: t("raidBg.set.dimsLabel", lang),
      value: `\`${RAID_BG_OUTPUT_WIDTH}x${RAID_BG_OUTPUT_HEIGHT}\``,
      inline: true,
    },
  ];
  if (slotLines) {
    fields.push({
      name: t("raidBg.view.slotsLabel", lang),
      value: slotLines,
      inline: false,
    });
  }
  if (assignmentLines) {
    fields.push({
      name: t("raidBg.set.assignmentLabel", lang),
      value: assignmentLines,
      inline: false,
    });
  }
  return fields;
}

async function handleSet({ interaction, deps, lang }) {
  const { User, getAccessibleAccounts, AttachmentBuilder, EmbedBuilder } = deps;
  const attachments = collectAttachments(interaction);
  const modeOption = interaction.options.getString("mode", false);
  const action = resolveSetAction(interaction);

  await deferEphemeralReply(interaction);

  const rosterNames = await loadVisibleRosterNames({
    User,
    discordId: interaction.user.id,
    getAccessibleAccounts,
  });
  if (rosterNames.length === 0) {
    await editNotice(interaction, EmbedBuilder, buildNoRosterNotice(lang));
    return;
  }

  const existing = action === "extend"
    ? await UserBackground.findOne({ discordId: interaction.user.id }).lean()
    : null;
  const existingImages = action === "extend" ? getStoredImages(existing) : [];
  const mode = resolveSetMode({ modeOption, existing });

  if (existingImages.length + attachments.length > RAID_BG_MAX_IMAGES) {
    await editNotice(interaction, EmbedBuilder, {
      kind: NoticeKind.INPUT,
      title: t("raidBg.set.tooManyImagesTitle", lang),
      description: t("raidBg.set.tooManyImagesDescription", lang, {
        max: RAID_BG_MAX_IMAGES,
        existing: existingImages.length,
      }),
      tip: t("raidBg.set.tooManyImagesTip", lang),
    });
    return;
  }

  let newImages;
  try {
    newImages = await processUploads(attachments);
  } catch (err) {
    if (!(err instanceof RaidBgError)) throw err;
    await editNotice(interaction, EmbedBuilder, buildUploadErrorNotice(err, lang));
    return;
  }

  const images = action === "extend"
    ? [...existingImages.map(normalizeStoredImage), ...newImages]
    : newImages;
  const assignments = buildAssignments(rosterNames, images.length, mode);

  try {
    await upsertLibrary(interaction.user.id, images, assignments, mode);
  } catch (err) {
    console.error("[raid-bg] storage write failed:", err?.message || err);
    await editNotice(interaction, EmbedBuilder, buildSaveFailedNotice(err, lang));
    return;
  }

  clearBackgroundCache(interaction.user.id);

  const preview = buildImagePreviewEmbeds({
    images,
    AttachmentBuilder,
    EmbedBuilder,
    namePrefix: "background-preview",
    color: UI.colors.success,
  });

  await editEmbed(interaction, [
    buildRaidBgEmbed(EmbedBuilder, {
      title: t("raidBg.set.successTitle", lang),
      description: t("raidBg.set.successDescription", lang),
      fields: buildSetSuccessFields({ images, assignments, mode, lang }),
      footer: t("raidBg.set.footer", lang),
      color: UI.colors.success,
    }),
    ...preview.embeds,
  ], { files: preview.files });
}

module.exports = {
  handleSet,
};
