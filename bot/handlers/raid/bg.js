/**
 * handlers/raid/bg.js
 *
 * /raid-bg command · set / view / remove the per-user background image for
 * the /raid-status canvas card. Storage moved to Mongo: uploaded bytes are
 * downscaled + JPEG-encoded to stay under ~2 MB then written as BSON Binary
 * on a dedicated UserBackground collection (separate from the User doc so
 * the per-command hot-path stays light). No rehost channel · no admin
 * setup · upload-and-go.
 *
 * All user-facing strings route through bot/services/i18n so Artist's
 * voice stays consistent with the rest of the bot and per-user language
 * (vi default / jp / en) is honored automatically.
 */

"use strict";

const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { t, getUserLanguage } = require("../../services/i18n");
const UserBackground = require("../../models/userBackground");
const {
  clearBackgroundCache,
  normalizeAccountKey,
} = require("../../services/raid-card/bg-loader");

// Discord-upload-boundary cap. Validation happens BEFORE decode/resize so
// the bot doesn't waste cycles loading a 50 MB attachment that's going to
// be rejected anyway. Storage cap (post-resize) is enforced separately by
// the resize loop below; this number only gates upload intake.
const RAID_BG_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const RAID_BG_UPLOAD_MAX_MB = RAID_BG_UPLOAD_MAX_BYTES / 1024 / 1024;
const RAID_BG_MIN_WIDTH = 800;
const RAID_BG_MIN_HEIGHT = 600;
const RAID_BG_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

// Resize target. Canvas card renders at 1200x720 with cover-fit, so anything
// larger than ~1920 on the long axis is wasted bytes. Quality stepdown
// 85 → 75 → 65 → 60 keeps the typical anime-art / wallpaper upload comfortably
// under 2 MB · the rare hyper-detailed source that resists JPEG compression
// drops to the last-resort 70%-scale + quality 60 path so storage stays
// bounded regardless of source content.
const RESIZE_MAX_DIM = 1920;
const STORAGE_TARGET_BYTES = 2 * 1024 * 1024;
const JPEG_QUALITY_LADDER = [85, 75, 65];
const RAID_BG_MAX_IMAGES = 4;
const RAID_BG_ASSIGNMENT_MODES = new Set(["even", "random"]);

/**
 * Custom Error subclass that carries an i18n key + interpolation params
 * instead of a baked English message. Lets the caller translate at the
 * top of the handler so the user sees Artist's voice in their preferred
 * language regardless of where in the validation chain the throw fired.
 */
class RaidBgError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

async function downloadAttachment(attachment) {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new RaidBgError("raidBg.errors.downloadFailed", { status: response.status });
  }
  return Buffer.from(await response.arrayBuffer());
}

async function validateBgAttachment(attachment, buffer) {
  const uploadedBytes = Number(attachment.size) || buffer.length;
  if (uploadedBytes > RAID_BG_UPLOAD_MAX_BYTES || buffer.length > RAID_BG_UPLOAD_MAX_BYTES) {
    throw new RaidBgError("raidBg.errors.sizeTooBig", {
      sizeMb: (Math.max(uploadedBytes, buffer.length) / 1024 / 1024).toFixed(1),
      maxMb: RAID_BG_UPLOAD_MAX_MB.toFixed(0),
    });
  }
  const mime = (attachment.contentType || "").toLowerCase().split(";")[0].trim();
  if (mime && !RAID_BG_ALLOWED_MIME.has(mime)) {
    throw new RaidBgError("raidBg.errors.formatUnsupported", { mime });
  }

  let img;
  try {
    img = await loadImage(buffer);
  } catch (err) {
    throw new RaidBgError("raidBg.errors.decodeFailed", { message: err.message });
  }

  if (img.width < RAID_BG_MIN_WIDTH || img.height < RAID_BG_MIN_HEIGHT) {
    throw new RaidBgError("raidBg.errors.tooSmall", {
      width: img.width,
      height: img.height,
      minW: RAID_BG_MIN_WIDTH,
      minH: RAID_BG_MIN_HEIGHT,
    });
  }

  return { img, mime, width: img.width, height: img.height };
}

/**
 * Downscale + JPEG-encode a decoded image into a buffer <= STORAGE_TARGET_BYTES.
 * Walks the quality ladder first; if quality 65 at maxDim 1920 still stays
 * over budget, keeps scaling down at quality 60 until the stored buffer fits.
 */
async function resizeForStorage(img) {
  let { width: w, height: h } = img;
  if (Math.max(w, h) > RESIZE_MAX_DIM) {
    const scale = RESIZE_MAX_DIM / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  for (const quality of JPEG_QUALITY_LADDER) {
    const out = await canvas.encode("jpeg", quality);
    if (out.length <= STORAGE_TARGET_BYTES) {
      return { buffer: out, width: w, height: h, quality, mime: "image/jpeg" };
    }
  }

  let fallbackW = Math.max(1, Math.round(w * 0.7));
  let fallbackH = Math.max(1, Math.round(h * 0.7));
  while (true) {
    const fallbackCanvas = createCanvas(fallbackW, fallbackH);
    fallbackCanvas.getContext("2d").drawImage(img, 0, 0, fallbackW, fallbackH);
    const fallback = await fallbackCanvas.encode("jpeg", 60);
    if (fallback.length <= STORAGE_TARGET_BYTES) {
      return {
        buffer: fallback,
        width: fallbackW,
        height: fallbackH,
        quality: 60,
        mime: "image/jpeg",
      };
    }
    fallbackW = Math.max(1, Math.round(fallbackW * 0.8));
    fallbackH = Math.max(1, Math.round(fallbackH * 0.8));
  }
}

// ─── Subcommand handlers ────────────────────────────────────────────────────

function collectAttachments(interaction) {
  const attachments = [interaction.options.getAttachment("image", true)];
  for (const name of ["image_2", "image_3", "image_4"]) {
    const att = interaction.options.getAttachment(name, false);
    if (att) attachments.push(att);
  }
  return attachments;
}

function shuffleCopy(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildAssignments(accountNames, imageCount, mode) {
  const seen = new Set();
  const rosters = [];
  for (const accountName of accountNames) {
    const accountKey = normalizeAccountKey(accountName);
    if (!accountKey || seen.has(accountKey)) continue;
    seen.add(accountKey);
    rosters.push({ accountName, accountKey });
  }
  const ordered = mode === "random" ? shuffleCopy(rosters) : rosters;
  return ordered.map((entry, index) => ({
    ...entry,
    imageIndex: index % imageCount,
  }));
}

async function loadOwnRosterNames(User, discordId) {
  if (!User || !discordId) return [];
  try {
    const doc = await User.findOne({ discordId })
      .select("accounts.accountName")
      .lean();
    return Array.isArray(doc?.accounts)
      ? doc.accounts.map((account) => account.accountName).filter(Boolean)
      : [];
  } catch (err) {
    console.warn(`[raid-bg] roster list read failed for ${discordId}:`, err?.message || err);
    return [];
  }
}

async function loadVisibleRosterNames({ User, discordId, getAccessibleAccounts }) {
  if (typeof getAccessibleAccounts === "function") {
    try {
      const accessible = await getAccessibleAccounts(discordId, {
        models: { User },
        includeOwn: true,
      });
      if (Array.isArray(accessible) && accessible.length > 0) {
        return accessible.map((entry) => entry.accountName).filter(Boolean);
      }
    } catch (err) {
      console.warn(`[raid-bg] accessible roster list read failed for ${discordId}:`, err?.message || err);
    }
  }

  return loadOwnRosterNames(User, discordId);
}

function normalizeStoredBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer || value);
}

function getStoredImages(bg) {
  if (Array.isArray(bg?.images) && bg.images.length > 0) return bg.images;
  if (bg?.imageData) return [bg];
  return [];
}

function formatAssignmentLines(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) return "";
  return assignments
    .slice(0, 10)
    .map((entry) => `\`${entry.accountName || entry.accountKey}\` -> #${(entry.imageIndex || 0) + 1}`)
    .join("\n");
}

async function handleSet({ interaction, deps, lang }) {
  const { User, getAccessibleAccounts, AttachmentBuilder, EmbedBuilder, MessageFlags } = deps;
  const attachments = collectAttachments(interaction);
  const modeOption = interaction.options.getString("mode", false);
  const mode = RAID_BG_ASSIGNMENT_MODES.has(modeOption) ? modeOption : "even";

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rosterNames = await loadVisibleRosterNames({
    User,
    discordId: interaction.user.id,
    getAccessibleAccounts,
  });
  if (rosterNames.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(t("raidBg.set.noRosterTitle", lang))
          .setDescription(t("raidBg.set.noRosterDescription", lang))
          .setColor(0x5865f2),
      ],
    });
    return;
  }

  const maxImages = Math.min(RAID_BG_MAX_IMAGES, rosterNames.length);
  if (attachments.length > maxImages) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(t("raidBg.set.tooManyImagesTitle", lang))
          .setDescription(t("raidBg.set.tooManyImagesDescription", lang, {
            count: attachments.length,
            max: maxImages,
          }))
          .setColor(0xfee75c),
      ],
    });
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
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const images = processed.map(({ filename, validated, resized }) => ({
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
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(t("raidBg.set.saveFailedTitle", lang))
          .setDescription(t("raidBg.errors.storageFailed", lang, {
            message: err?.message || String(err),
          }))
          .setColor(0xed4245),
      ],
    });
    return;
  }

  clearBackgroundCache(interaction.user.id);

  const first = processed[0];
  const previewName = "background-preview-1.jpg";
  const previewFile = new AttachmentBuilder(first.resized.buffer, { name: previewName });
  const totalKb = images.reduce((sum, image) => sum + image.sizeBytes, 0) / 1024;
  const assignmentLines = formatAssignmentLines(assignments);
  const fields = [
    {
      name: t("raidBg.set.imagesLabel", lang),
      value: t("raidBg.set.imagesValue", lang, {
        count: images.length,
        totalKb: totalKb.toFixed(0),
        max: maxImages,
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
      value: `\`${first.validated.width}x${first.validated.height}\` -> \`${first.resized.width}x${first.resized.height}\``,
      inline: true,
    },
  ];
  if (assignmentLines) {
    fields.push({
      name: t("raidBg.set.assignmentLabel", lang),
      value: assignmentLines,
      inline: false,
    });
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(t("raidBg.set.successTitle", lang))
        .setDescription(t("raidBg.set.successDescription", lang))
        .addFields(fields)
        .setFooter({ text: t("raidBg.set.footer", lang) })
        .setColor(0x57f287)
        .setImage(`attachment://${previewName}`),
    ],
    files: [previewFile],
  });
}

async function handleView({ interaction, deps, lang }) {
  const { AttachmentBuilder, EmbedBuilder, MessageFlags } = deps;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const bg = await UserBackground.findOne({ discordId: interaction.user.id }).lean();
  const images = getStoredImages(bg);
  if (images.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(t("raidBg.view.noneTitle", lang))
          .setDescription(t("raidBg.view.noneDescription", lang))
          .setColor(0x5865f2),
      ],
    });
    return;
  }

  const preview = images[0];
  const previewName = "background-current-1.jpg";
  const previewBuffer = normalizeStoredBuffer(preview.imageData);
  const previewFile = new AttachmentBuilder(previewBuffer, { name: previewName });
  const updatedAtTs = bg.updatedAt
    ? Math.floor(new Date(bg.updatedAt).getTime() / 1000)
    : null;
  const sizeKb = previewBuffer.length ? (previewBuffer.length / 1024).toFixed(0) : "?";
  const assignmentLines = formatAssignmentLines(bg.assignments);
  const fields = [
    {
      name: t("raidBg.view.fileLabel", lang),
      value: `\`${preview.originalFilename || "background"}\``,
      inline: true,
    },
    {
      name: t("raidBg.view.dimsLabel", lang),
      value: `\`${preview.width || "?"}x${preview.height || "?"} · ${sizeKb} KB\``,
      inline: true,
    },
    {
      name: t("raidBg.view.imagesLabel", lang),
      value: t("raidBg.view.imagesValue", lang, {
        count: images.length,
        mode: t(`raidBg.set.mode.${bg.mode || "even"}`, lang),
      }),
      inline: true,
    },
    {
      name: t("raidBg.view.uploadLabel", lang),
      value: updatedAtTs ? `<t:${updatedAtTs}:R>` : t("raidBg.view.uploadUnknown", lang),
      inline: true,
    },
  ];
  if (assignmentLines) {
    fields.push({
      name: t("raidBg.view.assignmentLabel", lang),
      value: assignmentLines,
      inline: false,
    });
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(t("raidBg.view.currentTitle", lang))
        .setDescription(t("raidBg.view.currentDescription", lang))
        .addFields(fields)
        .setFooter({ text: t("raidBg.view.footer", lang) })
        .setColor(0x5865f2)
        .setImage(`attachment://${previewName}`),
    ],
    files: [previewFile],
  });
}

async function handleRemove({ interaction, deps, lang }) {
  const { EmbedBuilder, MessageFlags } = deps;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const existing = await UserBackground.findOne({ discordId: interaction.user.id })
    .select("_id")
    .lean();
  if (!existing) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(t("raidBg.remove.nothingTitle", lang))
          .setDescription(t("raidBg.remove.nothingDescription", lang))
          .setColor(0x5865f2),
      ],
    });
    return;
  }

  await UserBackground.deleteOne({ discordId: interaction.user.id });
  clearBackgroundCache(interaction.user.id);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(t("raidBg.remove.successTitle", lang))
        .setDescription(t("raidBg.remove.successDescription", lang))
        .setColor(0x99aab5),
    ],
  });
}

// ─── Factory ────────────────────────────────────────────────────────────────

function createRaidBgCommand(deps) {
  const { User } = deps;
  async function handleRaidBgCommand(interaction) {
    // Resolve viewer language ONCE at handler entry so every subcommand
    // path renders in Artist's voice in the caller's preferred locale.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const sub = interaction.options.getSubcommand();
    if (sub === "set") return handleSet({ interaction, deps, lang });
    if (sub === "view") return handleView({ interaction, deps, lang });
    if (sub === "remove") return handleRemove({ interaction, deps, lang });
  }

  return {
    handleRaidBgCommand,
  };
}

module.exports = {
  createRaidBgCommand,
};
