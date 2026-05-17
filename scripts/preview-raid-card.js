/**
 * scripts/preview-raid-card.js
 *
 * Standalone prototype for the raid-status canvas card. Renders a sample
 * card with hardcoded fake roster/raid data so Traine can preview the
 * Arknights-style "background art + semi-transparent overlay panels"
 * aesthetic before the team commits to the full integration plan.
 *
 * Run:
 *   node scripts/preview-raid-card.js                 (gradient background)
 *   node scripts/preview-raid-card.js --bg <path>     (custom background image)
 *
 * Output:
 *   scripts/preview-raid-card.png
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createCanvas, loadImage } = require('@napi-rs/canvas');

// ─── Configuration ──────────────────────────────────────────────────────────

const CANVAS_W = 1200;
const CANVAS_H = 720;
const PADDING = 36;
const PANEL_ALPHA = 0.82;
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const CLASS_ICONS_DIR = path.join(ASSETS_DIR, 'class-icons');
const OUTPUT_PATH = path.join(__dirname, 'preview-raid-card.png');

// Fake roster data · approximates what /raid-status would feed the renderer.
const SAMPLE = {
  rosterName: "Traine's Bao",
  raid: 'Act 4 Hard',
  raidIcon: '⛔',
  lastUpdatedRelative: '2 hours ago',
  clearedCount: 8,
  totalGates: 16,
  characters: [
    { name: 'Bao',     classFile: 'berserker.png',         itemLevel: 1745.83, gates: [true, true, true, false] },
    { name: 'Lune',    classFile: 'holyknight.png',        itemLevel: 1730.00, gates: [true, true, false, false] },
    { name: 'Aoi',     classFile: 'bard.png',              itemLevel: 1715.50, gates: [true, false, false, false] },
    { name: 'Cherry',  classFile: 'berserker_female.png',  itemLevel: 1700.20, gates: [true, true, true, true] },
  ],
};

// ─── Background loader ──────────────────────────────────────────────────────

function parseBgArg() {
  const idx = process.argv.indexOf('--bg');
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  return next ? path.resolve(next) : null;
}

async function loadBackground(ctx) {
  const bgPath = parseBgArg();
  if (bgPath && fs.existsSync(bgPath)) {
    console.log(`[preview] Loading background from ${bgPath}`);
    const img = await loadImage(bgPath);
    // Cover-fit: scale background so it fills the canvas, crop overflow.
    const scale = Math.max(CANVAS_W / img.width, CANVAS_H / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const dx = (CANVAS_W - w) / 2;
    const dy = (CANVAS_H - h) / 2;
    ctx.drawImage(img, dx, dy, w, h);
    // Slight dark veil over the whole image so panels read on bright art.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    return;
  }

  console.log('[preview] No --bg supplied, using gradient placeholder.');
  // Default: dark blue-to-purple gradient that mimics a "night raid" mood.
  const gradient = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
  gradient.addColorStop(0, '#1a1a2e');
  gradient.addColorStop(0.5, '#16213e');
  gradient.addColorStop(1, '#0f3460');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  // Decorative diagonal accent line · subtle nod to Arknights-style angular UI.
  ctx.strokeStyle = 'rgba(255, 90, 90, 0.35)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_H * 0.65);
  ctx.lineTo(CANVAS_W, CANVAS_H * 0.35);
  ctx.stroke();
}

// ─── Panel + text helpers ───────────────────────────────────────────────────

/**
 * Draw a semi-transparent rounded panel · the building block of every
 * text block on the card. Optional left-edge accent stripe in the
 * Arknights style.
 */
function drawPanel(ctx, x, y, w, h, options = {}) {
  const { accentColor = null } = options;
  // Panel body
  ctx.fillStyle = `rgba(15, 18, 28, ${PANEL_ALPHA})`;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 12);
  ctx.fill();
  // Left accent stripe · gives panels the Arknights "speaker tag" feel.
  if (accentColor) {
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(x, y, 6, h, [12, 0, 0, 12]);
    ctx.fill();
  }
}

function drawProgressBar(ctx, x, y, w, h, fillRatio, fillColor) {
  // Bar track
  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  // Bar fill
  if (fillRatio > 0) {
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.roundRect(x, y, w * Math.min(1, fillRatio), h, h / 2);
    ctx.fill();
  }
}

// ─── Header panel ───────────────────────────────────────────────────────────

function drawHeader(ctx) {
  const x = PADDING;
  const y = PADDING;
  const w = CANVAS_W - PADDING * 2;
  const h = 110;
  drawPanel(ctx, x, y, w, h, { accentColor: '#ed4245' });

  // Raid name + icon
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${SAMPLE.raidIcon}  ${SAMPLE.raid}`, x + 30, y + 50);

  // Roster name
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.font = '22px sans-serif';
  ctx.fillText(SAMPLE.rosterName, x + 30, y + 84);

  // Cleared count badge top-right
  ctx.textAlign = 'right';
  ctx.fillStyle = '#57f287';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(`${SAMPLE.clearedCount} / ${SAMPLE.totalGates}`, x + w - 30, y + 50);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = '18px sans-serif';
  ctx.fillText('gates cleared', x + w - 30, y + 80);
  ctx.textAlign = 'left';
}

// ─── Character row ──────────────────────────────────────────────────────────

async function drawCharacterRow(ctx, char, index, top, width) {
  const rowH = 84;
  const y = top + index * (rowH + 14);
  const x = PADDING;
  drawPanel(ctx, x, y, width, rowH);

  // Class icon
  try {
    const iconPath = path.join(CLASS_ICONS_DIR, char.classFile);
    if (fs.existsSync(iconPath)) {
      const img = await loadImage(iconPath);
      ctx.drawImage(img, x + 18, y + 14, 56, 56);
    }
  } catch (err) {
    console.warn(`[preview] Class icon load failed for ${char.classFile}: ${err.message}`);
  }

  // Character name
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(char.name, x + 90, y + 38);

  // iLvl pill (next to name)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.font = '18px monospace';
  ctx.fillText(char.itemLevel.toFixed(2), x + 90, y + 64);

  // Gate progress · right side
  const progressX = x + 380;
  const progressW = width - 380 - 30;

  // Per-gate dots
  const gateRadius = 12;
  const gateSpacing = 36;
  for (let i = 0; i < char.gates.length; i += 1) {
    const cx = progressX + i * gateSpacing + gateRadius;
    const cy = y + rowH / 2;
    if (char.gates[i]) {
      ctx.fillStyle = '#57f287';
      ctx.beginPath();
      ctx.arc(cx, cy, gateRadius, 0, Math.PI * 2);
      ctx.fill();
      // Inner checkmark hint
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✓', cx, cy + 1);
    } else {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, gateRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Progress bar at the far right
  const cleared = char.gates.filter(Boolean).length;
  const total = char.gates.length;
  const ratio = cleared / total;
  const barX = progressX + char.gates.length * gateSpacing + 24;
  const barY = y + rowH / 2 - 8;
  const barW = progressW - char.gates.length * gateSpacing - 24;
  if (barW > 40) {
    drawProgressBar(ctx, barX, barY, barW, 16, ratio, ratio === 1 ? '#57f287' : '#f1c40f');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${cleared}/${total}`, barX + barW, barY - 4);
    ctx.textAlign = 'left';
  }
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function drawFooter(ctx) {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '16px sans-serif';
  ctx.fillText(
    `/raid-status to refresh · Last updated ${SAMPLE.lastUpdatedRelative}`,
    PADDING + 8,
    CANVAS_H - PADDING + 4,
  );
}

// ─── Main render ────────────────────────────────────────────────────────────

async function main() {
  const canvas = createCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext('2d');

  await loadBackground(ctx);
  drawHeader(ctx);

  const charsTop = PADDING + 110 + 22;
  const charsWidth = CANVAS_W - PADDING * 2;
  for (let i = 0; i < SAMPLE.characters.length; i += 1) {
    await drawCharacterRow(ctx, SAMPLE.characters[i], i, charsTop, charsWidth);
  }

  drawFooter(ctx);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(OUTPUT_PATH, buffer);
  const sizeKB = (buffer.length / 1024).toFixed(1);
  console.log(`[preview] Rendered card → ${OUTPUT_PATH} (${sizeKB} KB)`);
}

main().catch((err) => {
  console.error('[preview] Render failed:', err);
  process.exit(1);
});
