"use strict";

const { pack2Columns } = require("../common/shared");
const { t } = require("../../../services/i18n");

const HEADER_SEPARATOR = "\u00A0\u00B7\u00A0";

/**
 * Shared helper for the Task view layout used by both `/raid-status` and
 * `/raid-check` (Manager spot-check). Renders the per-character
 * card fields with the 2-column ZWS-spacer packing trick that matches the
 * raid view, plus rolls up daily/weekly totals so the caller can build
 * its own footer.
 *
 * Caller owns:
 *   - title (each surface labels differently: "Side tasks · {account}"
 *     for self-view, "{displayName} · {account}" for Manager view)
 *   - description (optional toggle hint, reset blurb, "read-only" notice)
 *   - footer (page indicator, totals format, surface-specific suffix)
 *   - any placeholder fields appended after the char cards
 *
 * Helper owns:
 *   - char field building (icons, daily/weekly section headers)
 *   - 2-column spacer packing for small rosters
 *   - totals math
 *   - layout switch math (2-column packing only stays inside Discord's
 *     25-field cap for small rosters; larger rosters render every char
 *     as a full-width field instead of hiding tasks)
 */

// With the spacer trick, 11 chars pack to 18 fields, leaving room for
// caller-added placeholder fields. Above this, render one field per char.
const PAGE_CHAR_CAP = 11;

function getCharacterName(character) {
  return String(character?.name || character?.charName || "").trim();
}

function formatItemLevel(character) {
  const raw = character?.itemLevel;
  const text = String(raw ?? "").trim();
  return text || "0";
}

function buildAccountTaskFields(account, helpers) {
  const {
    UI,
    getClassEmoji = () => "",
    truncateText = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s),
    // Optional viewer-language. Defaults to "vi" so any caller that
    // hasn't been migrated yet still produces VN copy (matching the
    // pre-i18n behavior). The shared helper renders into 3 surfaces:
    // /raid-status Side tasks, /raid-check Manager Task view, and
    // /raid-check task-view-ui - all pass lang explicitly post-i18n.
    lang = "vi",
  } = helpers;

  const characters = Array.isArray(account?.characters)
    ? account.characters
    : [];
  const charsWithTasks = characters.filter(
    (c) => Array.isArray(c?.sideTasks) && c.sideTasks.length > 0
  );

  const totals = {
    daily: 0,
    weekly: 0,
    dailyDone: 0,
    weeklyDone: 0,
    charsWithTasks: charsWithTasks.length,
    rendered: 0,
  };

  if (charsWithTasks.length === 0) {
    return { fields: [], totals };
  }

  const buildCharField = (character) => {
    const charName = getCharacterName(character);
    const classIcon = getClassEmoji(character.class);
    const namePrefix = classIcon ? `${classIcon} ` : "";
    const fieldName = truncateText(
      `${namePrefix}${charName}${HEADER_SEPARATOR}${formatItemLevel(character)}`,
      256
    );

    const sideTasks = Array.isArray(character.sideTasks)
      ? character.sideTasks
      : [];
    const dailyTasks = sideTasks.filter((t) => t?.reset === "daily");
    const weeklyTasks = sideTasks.filter((t) => t?.reset === "weekly");
    totals.daily += dailyTasks.length;
    totals.weekly += weeklyTasks.length;
    totals.dailyDone += dailyTasks.filter((t) => t?.completed).length;
    totals.weeklyDone += weeklyTasks.filter((t) => t?.completed).length;

    const lines = [];
    if (dailyTasks.length > 0) {
      const dailyDone = dailyTasks.filter((task) => task.completed).length;
      lines.push(
        `**${t("task-view.dailyHeader", lang)}** · ${dailyDone}/${dailyTasks.length}`
      );
      for (const task of dailyTasks) {
        const icon = task.completed ? UI.icons.done : UI.icons.pending;
        lines.push(`${icon} ${task.name}`);
      }
    }
    if (weeklyTasks.length > 0) {
      if (dailyTasks.length > 0) lines.push("");
      const weeklyDone = weeklyTasks.filter((task) => task.completed).length;
      lines.push(
        `**${t("task-view.weeklyHeader", lang)}** · ${weeklyDone}/${weeklyTasks.length}`
      );
      for (const task of weeklyTasks) {
        const icon = task.completed ? UI.icons.done : UI.icons.pending;
        lines.push(`${icon} ${task.name}`);
      }
    }
    return {
      name: fieldName,
      value: truncateText(
        lines.join("\n") || t("task-view.emptyCell", lang),
        1024
      ),
      inline: true,
    };
  };

  const charFields = charsWithTasks.map(buildCharField);
  totals.rendered = charFields.length;
  const fields =
    charFields.length <= PAGE_CHAR_CAP
      ? pack2Columns(charFields)
      : charFields.map((field) => ({ ...field, inline: false }));

  return { fields, totals };
}

module.exports = {
  PAGE_CHAR_CAP,
  buildAccountTaskFields,
};
