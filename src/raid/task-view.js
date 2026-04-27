"use strict";

const { pack2Columns } = require("./shared");

/**
 * Shared helper for the Task view layout used by both `/raid-status` and
 * `/raid-check raid:all` (Manager spot-check). Renders the per-character
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
 *   - 2-column spacer packing
 *   - totals math
 *   - cap math (max 11 chars-with-tasks per page so 2-column packing
 *     stays inside Discord's 25-field cap with room for caller-added
 *     placeholder + footer fields)
 */

const PAGE_CHAR_CAP = 11;

function getCharacterName(character) {
  return String(character?.name || character?.charName || "").trim();
}

function buildAccountTaskFields(account, helpers) {
  const {
    UI,
    getClassEmoji = () => "",
    truncateText = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s),
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
    const fieldName = truncateText(`${namePrefix}${charName}`, 256);

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
      const dailyDone = dailyTasks.filter((t) => t.completed).length;
      lines.push(`**Daily** · ${dailyDone}/${dailyTasks.length}`);
      for (const task of dailyTasks) {
        const icon = task.completed ? UI.icons.done : UI.icons.pending;
        lines.push(`${icon} ${task.name}`);
      }
    }
    if (weeklyTasks.length > 0) {
      if (lines.length > 0) lines.push("");
      const weeklyDone = weeklyTasks.filter((t) => t.completed).length;
      lines.push(`**Weekly** · ${weeklyDone}/${weeklyTasks.length}`);
      for (const task of weeklyTasks) {
        const icon = task.completed ? UI.icons.done : UI.icons.pending;
        lines.push(`${icon} ${task.name}`);
      }
    }
    return {
      name: fieldName,
      value: truncateText(lines.join("\n") || "(không có task)", 1024),
      inline: true,
    };
  };

  const visible = charsWithTasks.slice(0, PAGE_CHAR_CAP);
  totals.rendered = visible.length;
  const fields = pack2Columns(visible.map(buildCharField));

  return { fields, totals };
}

module.exports = {
  PAGE_CHAR_CAP,
  buildAccountTaskFields,
};
