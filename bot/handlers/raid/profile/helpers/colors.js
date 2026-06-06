"use strict";

/**
 * handlers/raid/profile/colors.js
 * Endfield-mock palette for /raid-profile embeds only.
 * Kept local (NOT in the bot-wide UI.colors) so the Endfield "lột xác" look
 * applies to this surface without recoloring every other command's embeds.
 * Hex values mirror the approved mock
 * (.claude/superpowers/mockups/2026-06-05-raid-profile-endfield.html):
 *   --accent #c9a23a (amber)  --bar-green #3ba55d (SUP)  --bar-amber #faa61a (shared).
 */
const PROFILE_COLORS = {
  // Dominant accent — overall, own roster, DPS character. The amber left-rail
  // is what makes the embed read as "Endfield HUD" instead of default blurple.
  amber: 0xc9a23a,
  // Support characters: warmer/desaturated green than the bot-wide neon
  // UI.colors.success, matching the mock's calmer --bar-green.
  support: 0x3ba55d,
  // Shared (not-own) roster: a warmer orange so own↔shared still reads at a
  // glance, while staying inside the warm Endfield family (no cold blurple).
  shared: 0xfaa61a,
};

module.exports = { PROFILE_COLORS };
