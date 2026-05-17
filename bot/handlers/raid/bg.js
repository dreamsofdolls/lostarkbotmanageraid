/**
 * handlers/raid/bg.js
 *
 * /raid-bg command · set / view / remove the per-user background image for
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

const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { Resvg } = require("@resvg/resvg-js");
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
  "image/svg+xml",
]);

// Stored embed image target. Discord keeps an embed image's aspect ratio, so
// portrait uploads render as narrow thumbnails unless Artist normalizes the
// stored frame. Quality stepdown keeps typical uploads under 2 MB.
const RAID_BG_OUTPUT_WIDTH = 1600;
const RAID_BG_OUTPUT_HEIGHT = 900;
const STORAGE_TARGET_BYTES = 2 * 1024 * 1024;
const JPEG_QUALITY_LADDER = [85, 75, 65];
const RAID_BG_MAX_IMAGES = 4;
const RAID_BG_ASSIGNMENT_MODES = new Set(["even", "random"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DECODE_SAFE_ANCILLARY = new Set([
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "pHYs",
  "sBIT",
  "bKGD",
]);

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

function looksLikeSvg(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024)).toString("utf8").trimStart();
  return sample.startsWith("<svg") || (sample.startsWith("<?xml") && sample.includes("<svg"));
}

function isPngBuffer(buffer) {
  return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function isJpegBuffer(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isWebpBuffer(buffer) {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function isPngCriticalChunk(type) {
  return type.length === 4 && type.charCodeAt(0) >= 0x41 && type.charCodeAt(0) <= 0x5a;
}

function stripPngAncillaryChunks(buffer) {
  if (!isPngBuffer(buffer)) return buffer;

  const parts = [buffer.subarray(0, PNG_SIGNATURE.length)];
  let changed = false;
  let sawIend = false;
  let offset = PNG_SIGNATURE.length;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkStart = offset;
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const chunkEnd = dataStart + length + 4;
    if (chunkEnd > buffer.length) return buffer;

    const type = buffer.subarray(typeStart, typeStart + 4).toString("ascii");
    const keep = isPngCriticalChunk(type) || PNG_DECODE_SAFE_ANCILLARY.has(type);
    if (keep) {
      parts.push(buffer.subarray(chunkStart, chunkEnd));
    } else {
      changed = true;
    }

    offset = chunkEnd;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }

  if (!changed || !sawIend) return buffer;
  return Buffer.concat(parts);
}

function detectMime(attachment, buffer) {
  const declared = (attachment.contentType || "").toLowerCase().split(";")[0].trim();
  if (looksLikeSvg(buffer)) return "image/svg+xml";
  if (isPngBuffer(buffer)) return "image/png";
  if (isJpegBuffer(buffer)) return "image/jpeg";
  if (isWebpBuffer(buffer)) return "image/webp";
  if (!declared || declared === "application/octet-stream") return "";
  return declared;
}

function renderSvgBuffer(buffer) {
  const svgText = buffer.toString("utf8");
  const probe = new Resvg(svgText);
  const sourceWidth = Math.round(probe.width || 0);
  const sourceHeight = Math.round(probe.height || 0);
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("SVG has no readable width/height");
  }

  let options = null;
  if (Math.max(sourceWidth, sourceHeight) > RAID_BG_OUTPUT_WIDTH) {
    options = sourceWidth >= sourceHeight
      ? { fitTo: { mode: "width", value: RAID_BG_OUTPUT_WIDTH } }
      : { fitTo: { mode: "height", value: RAID_BG_OUTPUT_WIDTH } };
  }

  const renderer = options ? new Resvg(svgText, options) : probe;
  return {
    buffer: renderer.render().asPng(),
    width: sourceWidth,
    height: sourceHeight,
  };
}

async function decodeBgImage(buffer, mime) {
  try {
    const img = await loadImage(buffer);
    return { img, width: img.width, height: img.height };
  } catch (err) {
    if (isPngBuffer(buffer)) {
      const stripped = stripPngAncillaryChunks(buffer);
      if (stripped !== buffer) {
        const img = await loadImage(stripped);
        return { img, width: img.width, height: img.height };
      }
    }

    if (mime !== "image/svg+xml" && !looksLikeSvg(buffer)) {
      throw err;
    }

    const rendered = renderSvgBuffer(buffer);
    const img = await loadImage(rendered.buffer);
    return { img, width: rendered.width, height: rendered.height };
  }
}

async function validateBgAttachment(attachment, buffer) {
  const uploadedBytes = Number(attachment.size) || buffer.length;
  if (uploadedBytes > RAID_BG_UPLOAD_MAX_BYTES || buffer.length > RAID_BG_UPLOAD_MAX_BYTES) {
    throw new RaidBgError("raidBg.errors.sizeTooBig", {
      sizeMb: (Math.max(uploadedBytes, buffer.length) / 1024 / 1024).toFixed(1),
      maxMb: RAID_BG_UPLOAD_MAX_MB.toFixed(0),
    });
  }
  const mime = detectMime(attachment, buffer);
  if (mime && !RAID_BG_ALLOWED_MIME.has(mime)) {
    throw new RaidBgError("raidBg.errors.formatUnsupported", { mime });
  }

  let decoded;
  try {
    decoded = await decodeBgImage(buffer, mime);
  } catch (err) {
    throw new RaidBgError("raidBg.errors.decodeFailed", { message: err.message });
  }

  if (decoded.width < RAID_BG_MIN_WIDTH || decoded.height < RAID_BG_MIN_HEIGHT) {
    throw new RaidBgError("raidBg.errors.tooSmall", {
      width: decoded.width,
      height: decoded.height,
      minW: RAID_BG_MIN_WIDTH,
      minH: RAID_BG_MIN_HEIGHT,
    });
  }

  return { img: decoded.img, mime, width: decoded.width, height: decoded.height };
}

function fitRect(sourceW, sourceH, targetW, targetH, mode) {
  const scale = mode === "cover"
    ? Math.max(targetW / sourceW, targetH / sourceH)
    : Math.min(targetW / sourceW, targetH / sourceH);
  const width = Math.round(sourceW * scale);
  const height = Math.round(sourceH * scale);
  return {
    x: Math.round((targetW - width) / 2),
    y: Math.round((targetH - height) / 2),
    width,
    height,
  };
}

function renderStorageCanvas(img, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, width, height);

  const backdrop = fitRect(img.width, img.height, width, height, "cover");
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.drawImage(img, backdrop.x, backdrop.y, backdrop.width, backdrop.height);
  ctx.restore();

  ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
  ctx.fillRect(0, 0, width, height);

  const foreground = fitRect(img.width, img.height, width, height, "contain");
  ctx.drawImage(img, foreground.x, foreground.y, foreground.width, foreground.height);

  return canvas;
}

/**
 * Normalize every upload to a 16:9 JPEG buffer <= STORAGE_TARGET_BYTES. The
 * source is shown whole with an image-derived backplate, so portrait art still
 * fills Discord's embed width without being aggressively cropped.
 */
async function resizeForStorage(img) {
  const canvas = renderStorageCanvas(img, RAID_BG_OUTPUT_WIDTH, RAID_BG_OUTPUT_HEIGHT);

  for (const quality of JPEG_QUALITY_LADDER) {
    const out = await canvas.encode("jpeg", quality);
    if (out.length <= STORAGE_TARGET_BYTES) {
      return {
        buffer: out,
        width: RAID_BG_OUTPUT_WIDTH,
        height: RAID_BG_OUTPUT_HEIGHT,
        quality,
        mime: "image/jpeg",
      };
    }
  }

  let fallbackW = Math.max(1, Math.round(RAID_BG_OUTPUT_WIDTH * 0.7));
  let fallbackH = Math.max(1, Math.round(RAID_BG_OUTPUT_HEIGHT * 0.7));
  while (true) {
    const fallbackCanvas = renderStorageCanvas(img, fallbackW, fallbackH);
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
  __test: {
    detectMime,
    stripPngAncillaryChunks,
  },
};
