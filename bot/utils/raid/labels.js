// Render-time helpers for raid + mode labels.
//
// models/Raid.js owns the canonical English labels (used as the source of
// truth for boss/iLvl/gold metadata). This module sits one layer above
// and resolves the user-visible label per locale via the i18n service.
//
// Helpers:
//   getRaidLabel(raidKey, lang)            → "Act 4" / "アクト4"
//   getModeLabel(modeKey, lang)            → "Normal" / "ノーマル"
//   getRaidModeLabel(raidKey, modeKey, l)  → "Act 4 Hard" / "アクト4 ハード"
//
// All three fall back to the canonical RAID_REQUIREMENTS labels when a
// locale doesn't have a key (i18n.t() handles that internally), so a
// new raid added to the model surfaces sanely even before its locale
// keys are written.
"use strict";

const { t } = require("../../services/i18n");
const { RAID_REQUIREMENTS } = require("../../models/Raid");

function getRaidLabel(raidKey, lang) {
  // Use the canonical label as the fallback chain's terminus: t() falls
  // back vi → key-string, but vi.js mirrors RAID_REQUIREMENTS so the
  // raw `raid.groups.<key>` lookup will hit. Belt-and-suspenders:
  // if a brand-new raid is added to the model before vi.js is updated,
  // surface its English label instead of "raid.groups.foo".
  const fallback = RAID_REQUIREMENTS[raidKey]?.label ?? raidKey;
  const resolved = t(`raid.groups.${raidKey}`, lang);
  if (resolved === `raid.groups.${raidKey}`) return fallback;
  return resolved;
}

function getModeLabel(modeKey, lang) {
  const resolved = t(`raid.modes.${modeKey}`, lang);
  if (resolved === `raid.modes.${modeKey}`) {
    // Capitalize the modeKey as a last-ditch fallback (e.g. "Normal").
    return modeKey ? modeKey[0].toUpperCase() + modeKey.slice(1) : "";
  }
  return resolved;
}

function getRaidModeLabel(raidKey, modeKey, lang) {
  const raid = getRaidLabel(raidKey, lang);
  const mode = getModeLabel(modeKey, lang);
  if (!mode) return raid;
  return `${raid} ${mode}`;
}

module.exports = {
  getRaidLabel,
  getModeLabel,
  getRaidModeLabel,
};
