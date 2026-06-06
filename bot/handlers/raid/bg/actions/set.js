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
  RAID_BG_UPLOAD_MAX_MB,
  RAID_BG_MIN_WIDTH,
  RAID_BG_MIN_HEIGHT,
  RAID_BG_OUTPUT_WIDTH,
  RAID_BG_OUTPUT_HEIGHT,
  downloadAttachment,
  validateBgAttachment,
  resizeForStorage,
} = require("../image-pipeline");
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

function isValidationError(err) {
  return err.key === "raidBg.errors.sizeTooBig"
    || err.key === "raidBg.errors.formatUnsupported"
    || err.key === "raidBg.errors.decodeFailed"
    || err.key === "raidBg.errors.tooSmall";
}

function buildProcessedImage({ filename, validated, resized }) {
  return {
    imageData: resized.buffer,
    mime: resized.mime,
    width: resized.width,
    height: resized.height,
    sizeBytes: resized.buffer.length,
    originalWidth: validated.width,
    originalHeight: validated.height,
    originalFilename: filename,
    originalMime: validated.mime || "",
    storageQuality: resized.quality,
  };
}

async function processUploads(attachments) {
  const processed = [];
  for (const attachment of attachments) {
    const buffer = await downloadAttachment(attachment);
    const validated = await validateBgAttachment(attachment, buffer);
    const resized = await resizeForStorage(validated.img);
    processed.push(buildProcessedImage({
      filename: attachment.name || `background-${processed.length + 1}.png`,
      validated,
      resized,
    }));
  }
  return processed;
}

async function replyUploadError({ interaction, EmbedBuilder, err, lang }) {
  const isValidation = isValidationError(err);
  const title = isValidation
    ? t("raidBg.set.rejectTitle", lang)
    : t("raidBg.set.downloadFailedTitle", lang);
  const color = isValidation ? 0xfee75c : 0xed4245;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(t(err.key, lang, err.params))
    .setColor(color);
  if (isValidation) {
    embed.addFields({
      name: t("raidBg.set.requirementsHeader", lang),
      value: t("raidBg.set.requirementsLines", lang, {
        minW: RAID_BG_MIN_WIDTH,
        minH: RAID_BG_MIN_HEIGHT,
        maxMb: RAID_BG_UPLOAD_MAX_MB.toFixed(0),
      }),
      inline: false,
    });
  }
  await editEmbed(interaction, embed);
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
    await editEmbed(interaction, buildRaidBgEmbed(EmbedBuilder, {
      title: t("raidBg.set.noRosterTitle", lang),
      description: t("raidBg.set.noRosterDescription", lang),
      color: 0x5865f2,
    }));
    return;
  }

  const existing = action === "extend"
    ? await UserBackground.findOne({ discordId: interaction.user.id }).lean()
    : null;
  const existingImages = action === "extend" ? getStoredImages(existing) : [];
  const mode = resolveSetMode({ modeOption, existing });

  if (existingImages.length + attachments.length > RAID_BG_MAX_IMAGES) {
    await editEmbed(interaction, buildRaidBgEmbed(EmbedBuilder, {
      title: t("raidBg.set.tooManyImagesTitle", lang),
      description: t("raidBg.set.tooManyImagesDescription", lang, {
        count: existingImages.length + attachments.length,
        max: RAID_BG_MAX_IMAGES,
        existing: existingImages.length,
      }),
      color: 0xfee75c,
    }));
    return;
  }

  let newImages;
  try {
    newImages = await processUploads(attachments);
  } catch (err) {
    if (!(err instanceof RaidBgError)) throw err;
    await replyUploadError({ interaction, EmbedBuilder, err, lang });
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
    await editEmbed(interaction, buildRaidBgEmbed(EmbedBuilder, {
      title: t("raidBg.set.saveFailedTitle", lang),
      description: t("raidBg.errors.storageFailed", lang, {
        message: err?.message || String(err),
      }),
      color: 0xed4245,
    }));
    return;
  }

  clearBackgroundCache(interaction.user.id);

  const preview = buildImagePreviewEmbeds({
    images,
    AttachmentBuilder,
    EmbedBuilder,
    namePrefix: "background-preview",
    color: 0x57f287,
  });

  await editEmbed(interaction, [
    buildRaidBgEmbed(EmbedBuilder, {
      title: t("raidBg.set.successTitle", lang),
      description: t("raidBg.set.successDescription", lang),
      fields: buildSetSuccessFields({ images, assignments, mode, lang }),
      footer: t("raidBg.set.footer", lang),
      color: 0x57f287,
    }),
    ...preview.embeds,
  ], { files: preview.files });
}

module.exports = {
  handleSet,
};
