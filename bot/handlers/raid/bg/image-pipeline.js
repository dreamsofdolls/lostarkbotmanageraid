"use strict";

const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { Resvg } = require("@resvg/resvg-js");

// Discord-upload-boundary cap. Validation happens before decode/resize so the
// bot does not waste cycles loading an oversized attachment.
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

// Stored embed image target. Discord keeps embed image aspect ratio, so portrait
// uploads are normalized to a wide frame before storage.
const RAID_BG_OUTPUT_WIDTH = 1600;
const RAID_BG_OUTPUT_HEIGHT = 900;
const STORAGE_TARGET_BYTES = 2 * 1024 * 1024;
const JPEG_QUALITY_LADDER = [85, 75, 65];
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

module.exports = {
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
};
