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
    // Decimal-preserving header. Item levels in Lost Ark have fractional
    // precision (1734.17, 1710.83) and the player relies on those digits
    // for honing decisions, so we keep them as-is. The previous "floor"
    // workaround for column-wrap is replaced by widening value-line
    // content below (raid-view-style `[icon] [name] · [info]` per task)
    // so Discord's auto-fit allocates wide enough columns and the header
    // never has to be trimmed.
    const itemLevel = Number(character.itemLevel) || 0;
    const classIcon = getClassEmoji(character.class);
    const namePrefix = classIcon ? `${classIcon} ` : "";
    // Keep the visual structure identical to raid-view headers, but bind
    // the separator to the iLvl with NBSP so Discord does not wrap
    // `1734.17` onto its own line in narrow inline-field columns.
    const fieldName = truncateText(
      `${namePrefix}${charName}\u00A0·\u00A0${itemLevel}`,
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

    // Task-line format intentionally mirrors the Raid view's
    // `[icon] [name] · [info]` pattern. Discord allocates inline-field
    // column width from the longest line in the embed's combined value
    // content - if every task line is just `[icon] [name]` (~11 chars)
    // the columns shrink and char-name headers like `Crimsonjudgment ·
    // 1700` wrap to a second line. Adding the `· daily`/`· weekly`
    // suffix bumps each task line to ~17-19 chars (parity with raid
    // lines like `🟢 Aegir Hard · 2/2`) and the columns auto-widen to
    // accommodate the long char headers without any per-header
    // truncation. The reset-cycle suffix is technically redundant with
    // the section header right above it, but it pulls double duty as a
    // visual padding mechanism and as quick-glance info while scrolling.
    const lines = [];
    if (dailyTasks.length > 0) {
      const dailyDone = dailyTasks.filter((t) => t.completed).length;
      lines.push(`**Daily** · ${dailyDone}/${dailyTasks.length}`);
      for (const task of dailyTasks) {
        const icon = task.completed ? UI.icons.done : UI.icons.pending;
        lines.push(`${icon} ${task.name} · daily`);
      }
    }
    if (weeklyTasks.length > 0) {
      if (lines.length > 0) lines.push("");
      const weeklyDone = weeklyTasks.filter((t) => t.completed).length;
      lines.push(`**Weekly** · ${weeklyDone}/${weeklyTasks.length}`);
      for (const task of weeklyTasks) {
        const icon = task.completed ? UI.icons.done : UI.icons.pending;
        lines.push(`${icon} ${task.name} · weekly`);
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
