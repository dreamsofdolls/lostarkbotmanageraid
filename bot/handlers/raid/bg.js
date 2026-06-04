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

const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { Resvg } = require("@resvg/resvg-js");
const { t, getUserLanguage } = require("../../services/i18n");
const UserBackground = require("../../models/userBackground");
const {
  clearBackgroundCache,
  normalizeAccountKey,
} = require("../../services/raid-card/bg-loader");
const {
  deferEphemeralReply,
  editEmbed,
} = require("../../utils/raid/common/shared");

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
const RAID_BG_MAX_IMAGES = 6;
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

// Re-shape a stored image sub-doc (from a .lean() read) into a clean,
// schema-shaped object with a real Buffer so `set action:extend` can re-save
// the existing scenes alongside freshly-processed uploads.
function normalizeStoredImage(image) {
  const buffer = normalizeStoredBuffer(image.imageData);
  return {
    imageData: buffer,
    mime: image.mime || "image/jpeg",
    width: image.width || 0,
    height: image.height || 0,
    sizeBytes: image.sizeBytes || (buffer ? buffer.length : 0),
    originalWidth: image.originalWidth || 0,
    originalHeight: image.originalHeight || 0,
    originalFilename: image.originalFilename || "",
    originalMime: image.originalMime || "",
    storageQuality: image.storageQuality || 85,
  };
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

function formatImageSlotLines(images) {
  return images
    .slice(0, RAID_BG_MAX_IMAGES)
    .map((image, index) => {
      const buffer = normalizeStoredBuffer(image.imageData);
      const sizeKb = buffer?.length ? (buffer.length / 1024).toFixed(0) : "?";
      const filename = formatInlineCodeText(
        image.originalFilename,
        `background-${index + 1}`,
        80,
      );
      return `#${index + 1} ${filename} - \`${image.width || "?"}x${image.height || "?"} · ${sizeKb} KB\``;
    })
    .join("\n");
}

function clampEmbedTitle(value, max = 240) {
  const text = String(value || "background").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatInlineCodeText(value, fallback, max = 80) {
  return `\`${clampEmbedTitle(value || fallback, max).replace(/`/g, "'")}\``;
}

function buildImagePreviewEmbeds({
  images,
  AttachmentBuilder,
  EmbedBuilder,
  namePrefix,
  color,
}) {
  const files = [];
  const embeds = [];

  images.slice(0, RAID_BG_MAX_IMAGES).forEach((image, index) => {
    const buffer = normalizeStoredBuffer(image.imageData);
    if (!buffer) return;

    const filename = `${namePrefix}-${index + 1}.jpg`;
    files.push(new AttachmentBuilder(buffer, { name: filename }));
    embeds.push(
      new EmbedBuilder()
        .setTitle(clampEmbedTitle(`#${index + 1} · ${image.originalFilename || "background"}`))
        .setColor(color)
        .setImage(`attachment://${filename}`),
    );
  });

  return { files, embeds };
}

function buildRaidBgEmbed(EmbedBuilder, {
  title,
  description,
  color,
  fields = [],
  footer,
}) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color);
  if (fields.length > 0) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

function compactAssignmentsAfterRemove(assignments, removedIndex, imageCount) {
  if (!Array.isArray(assignments) || assignments.length === 0 || imageCount <= 0) return [];
  return assignments
    .filter((entry) => entry && (entry.accountName || entry.accountKey))
    .map((entry) => {
      const current = Number.isInteger(entry.imageIndex) ? entry.imageIndex : 0;
      let imageIndex = current;
      if (current === removedIndex) {
        imageIndex = Math.min(removedIndex, imageCount - 1);
      } else if (current > removedIndex) {
        imageIndex = current - 1;
      }
      if (imageIndex < 0 || imageIndex >= imageCount) imageIndex = 0;
      return {
        accountName: entry.accountName || "",
        accountKey: entry.accountKey || normalizeAccountKey(entry.accountName),
        imageIndex,
      };
    });
}

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

// Browser session length for the interactive view / edit collectors.
const RAID_BG_BROWSER_MS = 3 * 60 * 1000;

/**
 * One ephemeral "scene browser" frame: a big image + info, a scene dropdown
 * (only when >= 2 scenes) and a variant-specific control row. `variant` drives
 * the chrome: "view" gets ◀ page ▶ nav, "replace"/"delete" get action buttons.
 * Pure - returns { embeds, files, components } for the given scene index.
 * @param {object} opts
 * @returns {{embeds: object[], files: object[], components: object[]}}
 */
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

  const meta = {
    view: { color: 0x5865f2, titleKey: "raidBg.browse.viewTitle", descKey: "raidBg.browse.viewDesc" },
    replace: { color: 0xfaa61a, titleKey: "raidBg.browse.replaceTitle", descKey: "raidBg.browse.replaceDesc" },
    delete: { color: 0xed4245, titleKey: "raidBg.browse.deleteTitle", descKey: "raidBg.browse.deleteDesc" },
  }[variant] || { color: 0x5865f2, titleKey: "raidBg.browse.viewTitle", descKey: "raidBg.browse.viewDesc" };

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(t(meta.titleKey, lang, { index: i + 1, total }))
    .setDescription(t(meta.descKey, lang, { file: image.originalFilename || `background-${i + 1}` }))
    .setImage(`attachment://${filename}`)
    .addFields(
      {
        name: t("raidBg.browse.dimsLabel", lang),
        value: `\`${image.width || "?"}x${image.height || "?"} · ${sizeKb} KB\``,
        inline: true,
      },
      {
        name: t("raidBg.browse.modeLabel", lang),
        value: `${t(`raidBg.set.mode.${mode || "even"}`, lang)} · ${total}`,
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
          label: clampEmbedTitle(`#${idx + 1} · ${img.originalFilename || "background"}`, 100),
          value: String(idx),
          default: idx === i,
        }))),
    ));
  }

  if (variant === "view") {
    if (total >= 2) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("raidbg:prev").setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(i === 0),
        new ButtonBuilder().setCustomId("raidbg:page").setLabel(`${i + 1}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId("raidbg:next").setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(i === total - 1),
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
