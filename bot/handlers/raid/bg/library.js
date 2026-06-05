"use strict";

const { normalizeAccountKey } = require("../../../services/raid-card/bg-loader");

const RAID_BG_MAX_IMAGES = 6;
const RAID_BG_ASSIGNMENT_MODES = new Set(["even", "random"]);

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
      return `#${index + 1} ${filename} - \`${image.width || "?"}x${image.height || "?"} \u00b7 ${sizeKb} KB\``;
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
        .setTitle(clampEmbedTitle(`#${index + 1} \u00b7 ${image.originalFilename || "background"}`))
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

module.exports = {
  RAID_BG_MAX_IMAGES,
  RAID_BG_ASSIGNMENT_MODES,
  collectAttachments,
  buildAssignments,
  loadVisibleRosterNames,
  normalizeStoredBuffer,
  normalizeStoredImage,
  getStoredImages,
  formatAssignmentLines,
  formatImageSlotLines,
  buildImagePreviewEmbeds,
  buildRaidBgEmbed,
  compactAssignmentsAfterRemove,
  clampEmbedTitle,
};
