/**
 * handlers/raid/bg.js
 *
 * /raid-bg command · set / view / edit the per-user background image for
 * the /raid-status embed image. Storage moved to Mongo: uploaded bytes are
 * normalized + JPEG-encoded to stay under ~2 MB then written as BSON Binary
 * on a dedicated UserBackground collection (separate from the User doc so
 * the per-command hot-path stays light). No rehost channel · no admin
 * setup · upload-and-go.
 *
 * All user-facing strings route through bot/services/i18n so Artist's
 * voice stays consistent with the rest of the bot and per-user language
 * (vi default / jp / en) is honored automatically.
 */

"use strict";

const { t, getUserLanguage } = require("../../services/i18n");
const UserBackground = require("../../models/userBackground");
const { clearBackgroundCache } = require("../../services/raid-card/bg-loader");
const {
  deferEphemeralReply,
  editEmbed,
} = require("../../utils/raid/common/shared");
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
  detectMime,
  stripPngAncillaryChunks,
} = require("./bg/image-pipeline");
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
  compactAssignmentsAfterRemove,
} = require("./bg/library");
const {
  RAID_BG_BROWSER_MS,
  buildSceneBrowserPayload,
  sceneBrowserUpdatePayload,
} = require("./bg/scene-browser");

// Subcommand handlers

async function handleSet({ interaction, deps, lang }) {
  const { User, getAccessibleAccounts, AttachmentBuilder, EmbedBuilder } = deps;
  const attachments = collectAttachments(interaction);
  const modeOption = interaction.options.getString("mode", false);
  const actionOption = interaction.options.getString("action", false);
  const action = actionOption === "extend" ? "extend" : "overwrite";

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

  // Extend appends to the existing library; overwrite replaces it. The pool
  // caps at RAID_BG_MAX_IMAGES regardless of roster count (extra scenes are
  // spares the auto-assigner / random mode draws from).
  const existing = action === "extend"
    ? await UserBackground.findOne({ discordId: interaction.user.id }).lean()
    : null;
  const existingImages = action === "extend" ? getStoredImages(existing) : [];
  const mode = RAID_BG_ASSIGNMENT_MODES.has(modeOption)
    ? modeOption
    : RAID_BG_ASSIGNMENT_MODES.has(existing?.mode) ? existing.mode : "even";

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

  const processed = [];
  try {
    for (const attachment of attachments) {
      const buffer = await downloadAttachment(attachment);
      const validated = await validateBgAttachment(attachment, buffer);
      const resized = await resizeForStorage(validated.img);
      processed.push({
        filename: attachment.name || `background-${processed.length + 1}.png`,
        validated,
        resized,
      });
    }
  } catch (err) {
    if (!(err instanceof RaidBgError)) throw err;
    const isValidation =
      err.key === "raidBg.errors.sizeTooBig"
      || err.key === "raidBg.errors.formatUnsupported"
      || err.key === "raidBg.errors.decodeFailed"
      || err.key === "raidBg.errors.tooSmall";
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
    return;
  }

  const newImages = processed.map(({ filename, validated, resized }) => ({
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
  }));
  // Extend keeps the existing scenes (re-shaped to real Buffers) and appends
  // the new ones; overwrite uses only the fresh uploads.
  const images = action === "extend"
    ? [...existingImages.map(normalizeStoredImage), ...newImages]
    : newImages;
  const assignments = buildAssignments(rosterNames, images.length, mode);

  try {
    await UserBackground.findOneAndUpdate(
      { discordId: interaction.user.id },
      {
        $set: {
          discordId: interaction.user.id,
          mode,
          images,
          assignments,
        },
        $unset: {
          imageData: "",
          mime: "",
          width: "",
          height: "",
          sizeBytes: "",
          originalWidth: "",
          originalHeight: "",
          originalFilename: "",
          originalMime: "",
          storageQuality: "",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
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
      fields,
      footer: t("raidBg.set.footer", lang),
      color: 0x57f287,
    }),
    ...preview.embeds,
  ], { files: preview.files });
}

/**
 * Persist the full library back (extend / replace / per-slot delete). Mirrors
 * handleSet's write so the legacy single-image fields stay unset.
 * @param {string} discordId
 * @param {Array} images - schema-shaped image sub-docs
 * @param {Array} assignments - account -> imageIndex rows
 * @param {string} mode - "even" | "random"
 * @returns {Promise<void>}
 */
async function saveLibrary(discordId, images, assignments, mode) {
  await UserBackground.findOneAndUpdate(
    { discordId },
    {
      $set: { discordId, mode: mode || "even", images, assignments },
      $unset: {
        imageData: "", mime: "", width: "", height: "", sizeBytes: "",
        originalWidth: "", originalHeight: "", originalFilename: "",
        originalMime: "", storageQuality: "",
      },
    },
    { new: true },
  );
}

async function handleView({ interaction, deps, lang }) {
  const {
    AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
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
    images, assignments: bg.assignments, mode: bg.mode, index, variant: "view", lang,
    AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  });
  const payload = render();
  const message = await editEmbed(interaction, payload.embeds, sceneBrowserUpdatePayload(payload));

  // Single scene -> nothing to page through, so skip the collector.
  if (images.length < 2 || !message?.createMessageComponentCollector) return;

  const collector = message.createMessageComponentCollector({ time: RAID_BG_BROWSER_MS });
  collector.on("collect", async (component) => {
    const id = component.customId;
    if (id === "raidbg:scene") index = Number(component.values?.[0]) || 0;
    else if (id === "raidbg:prev") index = Math.max(0, index - 1);
    else if (id === "raidbg:next") index = Math.min(images.length - 1, index + 1);
    else return;
    const next = render();
    await component.update(sceneBrowserUpdatePayload(next));
  });
  collector.on("end", async () => {
    try { await interaction.editReply({ components: [] }); } catch { /* message gone */ }
  });
}

async function handleEdit({ interaction, deps, lang }) {
  const {
    AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  } = deps;
  // A new image at invocation = REPLACE mode (Discord can't prompt for a file
  // mid-interaction); no image = DELETE mode.
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

  // Validate + resize the replacement up front so the picker only commits a
  // known-good image when the lead presses the button.
  let replacement = null;
  if (variant === "replace") {
    try {
      const buffer = await downloadAttachment(replaceAttachment);
      const validated = await validateBgAttachment(replaceAttachment, buffer);
      const resized = await resizeForStorage(validated.img);
      replacement = {
        imageData: resized.buffer, mime: resized.mime, width: resized.width, height: resized.height,
        sizeBytes: resized.buffer.length, originalWidth: validated.width, originalHeight: validated.height,
        originalFilename: replaceAttachment.name || "background.jpg", originalMime: validated.mime || "",
        storageQuality: resized.quality,
      };
    } catch (err) {
      if (!(err instanceof RaidBgError)) throw err;
      await editEmbed(interaction, buildRaidBgEmbed(EmbedBuilder, {
        title: t("raidBg.set.rejectTitle", lang),
        description: t(err.key, lang, err.params),
        color: 0xfee75c,
      }));
      return;
    }
  }

  let images = baseImages.map(normalizeStoredImage);
  let assignments = (bg.assignments || []).map((entry) => ({ ...entry }));
  const mode = RAID_BG_ASSIGNMENT_MODES.has(bg?.mode) ? bg.mode : "even";
  let index = 0;

  const render = () => buildSceneBrowserPayload({
    images, assignments, mode, index, variant, lang,
    AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  });
  const payload = render();
  const message = await editEmbed(interaction, payload.embeds, sceneBrowserUpdatePayload(payload));
  if (!message?.createMessageComponentCollector) return;

  const finalNotice = (component, opts) => component.update({
    embeds: [buildRaidBgEmbed(EmbedBuilder, opts)],
    files: [],
    attachments: [],
    components: [],
  });

  const collector = message.createMessageComponentCollector({ time: RAID_BG_BROWSER_MS });
  collector.on("collect", async (component) => {
    const id = component.customId;
    try {
      if (id === "raidbg:scene") {
        index = Number(component.values?.[0]) || 0;
        const next = render();
        await component.update(sceneBrowserUpdatePayload(next));
        return;
      }
      if (id === "raidbg:doreplace") {
        images[index] = replacement;
        await saveLibrary(interaction.user.id, images, assignments, mode);
        clearBackgroundCache(interaction.user.id);
        collector.stop("done");
        await finalNotice(component, {
          title: t("raidBg.edit.replacedTitle", lang),
          description: t("raidBg.edit.replacedDescription", lang, { index: index + 1 }),
          color: 0x57f287,
        });
        return;
      }
      if (id === "raidbg:deleteall" || (id === "raidbg:dodelete" && images.length <= 1)) {
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
      if (id === "raidbg:dodelete") {
        const removed = index;
        images = images.filter((_image, idx) => idx !== removed);
        assignments = compactAssignmentsAfterRemove(assignments, removed, images.length);
        if (index >= images.length) index = images.length - 1;
        await saveLibrary(interaction.user.id, images, assignments, mode);
        clearBackgroundCache(interaction.user.id);
        const next = render();
        await component.update(sceneBrowserUpdatePayload(next));
        return;
      }
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

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build the /raid-bg command handler factory.
 * Subcommand-based: `set` (upload 1-4 images, overwrite/extend the library),
 * `view` (interactive scene browser), `edit` (replace a scene with an attached
 * image, or delete scenes). Interactive subcommands need the discord.js
 * component builders (ActionRow/Button/ButtonStyle/StringSelectMenu) in deps.
 * @param {object} deps - injected dependencies
 * @param {object} deps.User - Mongoose User model (locale lookup)
 *   plus discord.js builders and the userbackgrounds storage layer
 *   resolved internally · see destructure block.
 * @returns {{handleRaidBgCommand: Function}}
 */
function createRaidBgCommand(deps) {
  const { User } = deps;
  async function handleRaidBgCommand(interaction) {
    // Resolve viewer language ONCE at handler entry so every subcommand
    // path renders in Artist's voice in the caller's preferred locale.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const sub = interaction.options.getSubcommand();
    if (sub === "set") return handleSet({ interaction, deps, lang });
    if (sub === "view") return handleView({ interaction, deps, lang });
    if (sub === "edit") return handleEdit({ interaction, deps, lang });
  }

  return {
    handleRaidBgCommand,
  };
}

module.exports = {
  createRaidBgCommand,
  __test: {
    detectMime,
    stripPngAncillaryChunks,
    compactAssignmentsAfterRemove,
    buildSceneBrowserPayload,
    RAID_BG_MAX_IMAGES,
  },
};
