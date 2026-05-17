/**
 * services/raid-card/index.js
 *
 * Canvas renderer for the /raid-status card · the surface that hooks
 * onto a user's chosen background image (set via /raid-bg) and paints
 * roster + raid + per-character progress on top with semi-transparent
 * panels in the Arknights-Endfield "profile card" aesthetic.
 *
 * Public surface is `renderRaidStatusCard(input)` · a single async fn
 * that takes a normalised render input and returns a PNG Buffer the
 * caller can attach to a Discord reply.
 *
 * Layout (1200x720 canvas):
 *   • Background: cover-fit user image · falls back to a midnight
 *     gradient when no URL is supplied (so /raid-status still renders
 *     the canvas card for opted-in users whose stored image is gone).
 *   • Dark veil 28% on top of any image background · guarantees text
 *     panels stay readable on bright source art.
 *   • Header panel: list icon + raid name (left), cleared/total badge
 *     (right), roster name on the second line.
 *   • Up to 6 character rows: class icon + name + ilvl + per-gate
 *     filled/hollow dots + right-side progress bar.
 *   • Footer line: refresh hint + last-updated relative timestamp.
 *
 * Strings inside the canvas are hard-coded English at the moment ·
 * a follow-up commit can route them through bot/services/i18n once
 * we have a font that covers VN diacritics + JP kana in @napi-rs/canvas.
 * The placeholder values (header copy, cleared label, footer hint) are
 * marked with TODO comments below for that follow-up.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createCanvas, loadImage } = require("@napi-rs/canvas");

const ROOT_ASSETS_DIR = path.resolve(__dirname, "..", "..", "..", "assets");
const CLASS_ICONS_DIR = path.join(ROOT_ASSETS_DIR, "class-icons");

const CANVAS_W = 1200;
const CANVAS_H = 720;
const PADDING = 36;
const PANEL_ALPHA = 0.82;
const PANEL_FILL = `rgba(15, 18, 28, ${PANEL_ALPHA})`;
const DARK_VEIL = "rgba(0, 0, 0, 0.28)";
const HEADER_HEIGHT = 110;
const ROW_HEIGHT = 84;
const ROW_GAP = 14;
const MAX_VISIBLE_CHARS = 6;

// Per-list-type accents · pulled from raid metadata (Act4 / Kazeros /
// Serca etc. all share the blacklist-style red because "raid in
// progress" reads severity-like). Callers can override via input.raid.color.
const DEFAULT_ACCENT = "#ed4245";

// ─── Background painter ────────────────────────────────────────────────────

async function paintBackground(ctx, backgroundSource) {
  // backgroundSource can be Buffer (Mongo-loaded UserBackground.imageData)
  // or string URL (legacy / external override). loadImage accepts both;
  // we centralize the decode here so the renderer doesn't care about
  // where the bytes came from.
  if (backgroundSource) {
    try {
      const img = await loadImage(backgroundSource);
      const scale = Math.max(CANVAS_W / img.width, CANVAS_H / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const dx = (CANVAS_W - w) / 2;
      const dy = (CANVAS_H - h) / 2;
      ctx.drawImage(img, dx, dy, w, h);
      ctx.fillStyle = DARK_VEIL;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      return;
    } catch (err) {
      // Background decode failed (corrupt bytes, network blip on a URL
      // source). Fall through to the gradient default · the card still
      // renders so /raid-status doesn't go down because of one bad source.
      console.warn(`[raid-card] background load failed, using gradient: ${err.message}`);
    }
  }

  // Default gradient · midnight blue to deep navy. Same mood as the
  // prototype Traine approved, doubles as the "no background set yet"
  // visual for users who run /raid-status without /raid-bg first.
  const gradient = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
  gradient.addColorStop(0, "#1a1a2e");
  gradient.addColorStop(0.5, "#16213e");
  gradient.addColorStop(1, "#0f3460");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = "rgba(255, 90, 90, 0.35)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_H * 0.65);
  ctx.lineTo(CANVAS_W, CANVAS_H * 0.35);
  ctx.stroke();
}

// ─── Panel primitives ──────────────────────────────────────────────────────

function drawPanel(ctx, x, y, w, h, options = {}) {
  const { accentColor = null } = options;
  ctx.fillStyle = PANEL_FILL;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 12);
  ctx.fill();
  if (accentColor) {
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(x, y, 6, h, [12, 0, 0, 12]);
    ctx.fill();
  }
}

function drawProgressBar(ctx, x, y, w, h, fillRatio, fillColor) {
  ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  if (fillRatio > 0) {
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.roundRect(x, y, w * Math.min(1, fillRatio), h, h / 2);
    ctx.fill();
  }
}

// ─── Header ─────────────────────────────────────────────────────────────────

function drawHeader(ctx, input) {
  const x = PADDING;
  const y = PADDING;
  const w = CANVAS_W - PADDING * 2;
  drawPanel(ctx, x, y, w, HEADER_HEIGHT, {
    accentColor: input.raid.color || DEFAULT_ACCENT,
  });

  // Raid name + icon (left side, top line)
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 36px sans-serif";
  ctx.textBaseline = "alphabetic";
  const raidLabel = input.raid.icon
    ? `${input.raid.icon}  ${input.raid.name}`
    : input.raid.name;
  ctx.fillText(raidLabel, x + 30, y + 50);

  // Roster name (left side, second line)
  ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
  ctx.font = "22px sans-serif";
  ctx.fillText(input.rosterName, x + 30, y + 84);

  // Cleared count (right side)
  // TODO i18n · "gates cleared" string belongs in locales when canvas
  // gets a font that covers VN/JP glyphs.
  ctx.textAlign = "right";
  ctx.fillStyle = "#57f287";
  ctx.font = "bold 32px sans-serif";
  ctx.fillText(`${input.cleared.count} / ${input.cleared.total}`, x + w - 30, y + 50);
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.font = "18px sans-serif";
  ctx.fillText("gates cleared", x + w - 30, y + 80);
  ctx.textAlign = "left";
}

// ─── Class icon cache ──────────────────────────────────────────────────────
//
// Class icons are static PNGs in assets/class-icons/. Loading them once
// per card is wasteful when the same classId repeats across rows · a
// process-level cache keyed by absolute path keeps icon decode cost
// at zero for warm rosters.

const classIconCache = new Map();

async function loadClassIcon(classId) {
  if (!classId) return null;
  const filename = `${classId}.png`;
  const fullPath = path.join(CLASS_ICONS_DIR, filename);
  if (classIconCache.has(fullPath)) {
    return classIconCache.get(fullPath);
  }
  if (!fs.existsSync(fullPath)) {
    classIconCache.set(fullPath, null);
    return null;
  }
  try {
    const img = await loadImage(fullPath);
    classIconCache.set(fullPath, img);
    return img;
  } catch (err) {
    console.warn(`[raid-card] class icon load failed for ${classId}: ${err.message}`);
    classIconCache.set(fullPath, null);
    return null;
  }
}

// ─── Character row ─────────────────────────────────────────────────────────

async function drawCharacterRow(ctx, char, index, top, width) {
  const y = top + index * (ROW_HEIGHT + ROW_GAP);
  const x = PADDING;
  drawPanel(ctx, x, y, width, ROW_HEIGHT);

  const classImg = await loadClassIcon(char.classId);
  if (classImg) {
    ctx.drawImage(classImg, x + 18, y + 14, 56, 56);
  }

  // Character name + iLvl stacked left
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 26px sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(char.name, x + 90, y + 38);
  ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
  ctx.font = "18px monospace";
  ctx.fillText(
    typeof char.itemLevel === "number" ? char.itemLevel.toFixed(2) : String(char.itemLevel || "?"),
    x + 90,
    y + 64,
  );

  // Gate dots
  const gates = Array.isArray(char.gates) ? char.gates : [];
  const progressX = x + 380;
  const gateRadius = 12;
  const gateSpacing = 36;
  for (let i = 0; i < gates.length; i += 1) {
    const cx = progressX + i * gateSpacing + gateRadius;
    const cy = y + ROW_HEIGHT / 2;
    const cleared = Boolean(gates[i]?.cleared ?? gates[i]);
    if (cleared) {
      ctx.fillStyle = "#57f287";
      ctx.beginPath();
      ctx.arc(cx, cy, gateRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("✓", cx, cy + 1);
    } else {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, gateRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Right-side progress bar
  if (gates.length > 0) {
    const clearedCount = gates.filter((g) => g?.cleared ?? g).length;
    const ratio = clearedCount / gates.length;
    const barX = progressX + gates.length * gateSpacing + 24;
    const barY = y + ROW_HEIGHT / 2 - 8;
    const barW = width - (barX - x) - 30;
    if (barW > 40) {
      drawProgressBar(ctx, barX, barY, barW, 16, ratio, ratio === 1 ? "#57f287" : "#f1c40f");
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`${clearedCount}/${gates.length}`, barX + barW, barY - 4);
      ctx.textAlign = "left";
    }
  }
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function drawFooter(ctx, input) {
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  ctx.font = "16px sans-serif";
  const lastUpdatedFragment = input.lastUpdatedLabel
    ? ` · ${input.lastUpdatedLabel}`
    : "";
  // TODO i18n · "/raid-status to refresh · ..." belongs in locales when
  // canvas gets a font that covers VN/JP glyphs.
  ctx.fillText(
    `/raid-status to refresh${lastUpdatedFragment}`,
    PADDING + 8,
    CANVAS_H - PADDING + 4,
  );
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Render the /raid-status canvas card.
 *
 * @param {Object} input
 * @param {string} input.rosterName - Display name shown below the raid title.
 * @param {Object} input.raid - Raid metadata.
 * @param {string} input.raid.name - Raid display name (e.g. "Act 4 Hard").
 * @param {string} [input.raid.icon] - Emoji prefix for the raid title.
 * @param {string} [input.raid.color] - Accent stripe color hex (e.g. "#ed4245").
 * @param {Array} input.characters - Character rows (max 6 rendered).
 * @param {string} input.characters[].name
 * @param {string} input.characters[].classId - Maps to assets/class-icons/<id>.png.
 * @param {number} input.characters[].itemLevel
 * @param {Array<{cleared:boolean}>} input.characters[].gates
 * @param {Object} input.cleared - Aggregate progress badge.
 * @param {number} input.cleared.count
 * @param {number} input.cleared.total
 * @param {Buffer|string} [input.backgroundSource] - User-supplied background
 *   image bytes (Buffer from UserBackground) or URL string. Either form is
 *   accepted by @napi-rs/canvas's loadImage.
 * @param {string} [input.lastUpdatedLabel] - Relative-time string for the footer.
 * @returns {Promise<Buffer>} PNG buffer ready to send as a Discord attachment.
 */
async function renderRaidStatusCard(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("renderRaidStatusCard requires an input object.");
  }
  if (!input.rosterName || !input.raid?.name || !Array.isArray(input.characters)) {
    throw new TypeError(
      "renderRaidStatusCard requires rosterName, raid.name, and characters[].",
    );
  }

  const canvas = createCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext("2d");

  await paintBackground(ctx, input.backgroundSource || null);
  drawHeader(ctx, {
    rosterName: input.rosterName,
    raid: input.raid,
    cleared: input.cleared || { count: 0, total: 0 },
  });

  const charsTop = PADDING + HEADER_HEIGHT + 22;
  const charsWidth = CANVAS_W - PADDING * 2;
  const visibleChars = input.characters.slice(0, MAX_VISIBLE_CHARS);
  for (let i = 0; i < visibleChars.length; i += 1) {
    await drawCharacterRow(ctx, visibleChars[i], i, charsTop, charsWidth);
  }

  drawFooter(ctx, input);

  return canvas.toBuffer("image/png");
}

module.exports = {
  renderRaidStatusCard,
  CANVAS_W,
  CANVAS_H,
};
