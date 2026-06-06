"use strict";

const { t } = require("../../../../services/i18n");
const { listEligibleCharacters } = require("../../../../services/raid/schedule/slots/eligibility");
const { getClassEmoji } = require("../../../../models/Class");

const PICKER_LIMIT = 25;

function clip(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}\u2026`;
}

function classEmojiOption(className) {
  const match = /^<(a)?:(\w+):(\d+)>$/.exec(getClassEmoji(className) || "");
  if (!match) return null;
  return match[1]
    ? { id: match[3], name: match[2], animated: true }
    : { id: match[3], name: match[2] };
}

function roleLabel(role, lang) {
  const roleKey = role === "support" ? "support" : "dps";
  return t(`raid-schedule.picker.role.${roleKey}`, lang);
}

function findOwnEligibleRows(userDoc, event) {
  const rows = listEligibleCharacters(userDoc?.accounts || [], {
    raidKey: event.raidKey,
    minItemLevel: event.minItemLevel,
  });
  return rows
    .map((row, index) => ({ ...row, index }))
    .filter((row) => row.eligible);
}

function characterRowOption(row, lang) {
  const cleared = row.alreadyCleared
    ? ` ${t("raid-schedule.picker.alreadyClearedSuffix", lang)}`
    : "";
  const emoji = classEmojiOption(row.className);
  return {
    label: clip(row.name, 100),
    value: String(row.index),
    description: clip(
      `${row.accountName} \u00b7 ${row.itemLevel} \u00b7 ${roleLabel(row.role, lang)}${cleared}`,
      100,
    ),
    ...(emoji ? { emoji } : {}),
  };
}

function characterSelectOptions(rows, lang, limit = PICKER_LIMIT) {
  return rows.slice(0, limit).map((row) => characterRowOption(row, lang));
}

function signupOption(signup, lang, defaults = null) {
  const emoji = classEmojiOption(signup.characterClass);
  const option = {
    label: clip(signup.characterName, 100),
    value: signup.discordId,
    description: clip(
      `${signup.accountName} \u00b7 ${signup.characterItemLevel} \u00b7 ${roleLabel(signup.role, lang)}`,
      100,
    ),
    ...(emoji ? { emoji } : {}),
  };
  if (defaults) option.default = defaults.has(signup.discordId);
  return option;
}

function signupSelectOptions(signups, lang, defaults = null, limit = PICKER_LIMIT) {
  return (signups || [])
    .slice(0, limit)
    .map((signup) => signupOption(signup, lang, defaults));
}

module.exports = {
  PICKER_LIMIT,
  clip,
  findOwnEligibleRows,
  characterSelectOptions,
  signupSelectOptions,
};
