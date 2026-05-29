/**
 * handlers/raid/schedule/board.js
 * Render the /raid-schedule event board: the embed (raid + countdown +
 * comp columns + waitlist + RSVP zones + room line) and the three
 * component rows (status / utility / lead). Pure-ish builders - they take
 * the discord.js constructors + UI palette via deps so they stay unit-
 * testable without a live client. Slot placement is derived live from the
 * signups via slots.assignSlots (no stored slot index). Custom IDs follow
 * the `rse:<action>:<eventId>` scheme the interaction router prefix-matches.
 */

"use strict";

const { t } = require("../../../services/i18n");
const { getClassEmoji, isSupportClass } = require("../../../models/Class");
const { getRaidRequirementMap } = require("../../../domain/raid-catalog");
const { assignSlots } = require("../../../services/raid/schedule/slots");

// Lifecycle -> embed stripe color (mapped onto the shared UI palette).
function stripeColor(UI, status) {
  if (status === "cleared") return UI.colors.success;
  if (status === "cancelled") return UI.colors.danger;
  if (status === "locked") return UI.colors.warn || UI.colors.neutral;
  return UI.colors.progress;
}

// Discord native relative + absolute timestamp pair. Auto-localizes to
// each viewer's own region, so we never compute per-language clock text.
function discordTime(date) {
  const sec = Math.floor(new Date(date).getTime() / 1000);
  return { rel: `<t:${sec}:R>`, abs: `<t:${sec}:f>` };
}

function rosterLabel(raidKey, modeKey) {
  const meta = getRaidRequirementMap()[`${raidKey}_${modeKey}`];
  return meta ? meta.label : `${raidKey} ${modeKey}`;
}

// One comp slot line: "1 🎵 Name 1725" with a late flag when applicable.
function slotLine(index, signup) {
  const emoji = getClassEmoji(signup.characterClass) || (isSupportClass(signup.characterClass) ? "🛡️" : "⚔️");
  const late = signup.status === "late" ? " 🕐" : "";
  return `\`${index}\` ${emoji} **${signup.characterName}**${late} · ${signup.characterItemLevel}`;
}

function emptySlotLine(index, lang) {
  return `\`${index}\` ＋ *${t("raid-schedule.board.emptySlot", lang)}*`;
}

function buildColumn(filled, slotCount, lang) {
  const lines = [];
  for (let i = 0; i < slotCount; i += 1) {
    lines.push(filled[i] ? slotLine(i + 1, filled[i]) : emptySlotLine(i + 1, lang));
  }
  return lines.join("\n") || "-";
}

/**
 * Build the event board embed.
 * @param {object} event - RaidEvent (lean object or doc)
 * @param {{EmbedBuilder: Function, UI: object, lang?: string}} deps
 * @returns {object} a discord.js EmbedBuilder instance
 */
function buildScheduleEmbed(event, { EmbedBuilder, UI, lang = "vi" }) {
  const { support, dps, waitlist } = assignSlots(event.signups, {
    supSlots: event.supSlots,
    dpsSlots: event.dpsSlots,
  });
  const compCount = support.length + dps.length;
  const time = discordTime(event.startAt);
  const raidName = rosterLabel(event.raidKey, event.modeKey);

  const descLines = [
    t("raid-schedule.board.summary", lang, {
      raid: raidName,
      ilvl: event.minItemLevel,
    }),
    t("raid-schedule.board.startLine", lang, { rel: time.rel, abs: time.abs }),
    t("raid-schedule.board.leadLine", lang, { lead: `<@${event.creatorId}>` }),
  ];
  if (event.roomName) {
    descLines.push(
      t("raid-schedule.board.roomLine", lang, { room: event.roomName })
    );
  }
  descLines.push(
    t("raid-schedule.board.progress", lang, {
      n: compCount,
      size: event.partySize,
      waitlist: waitlist.length,
    })
  );

  const embed = new EmbedBuilder()
    .setColor(stripeColor(UI, event.status))
    .setTitle(t(`raid-schedule.board.title.${event.status}`, lang, { title: event.title || raidName }))
    .setDescription(descLines.join("\n"));

  if (event.status === "cleared" || event.status === "cancelled") {
    // Frozen final state: keep the comp as a record, drop the empty slots.
    embed.addFields(
      { name: t("raid-schedule.board.supportHeader", lang, { n: support.length, slots: event.supSlots }), value: support.map((s, i) => slotLine(i + 1, s)).join("\n") || "-", inline: true },
      { name: t("raid-schedule.board.dpsHeader", lang, { n: dps.length, slots: event.dpsSlots }), value: dps.map((s, i) => slotLine(i + 1, s)).join("\n") || "-", inline: true }
    );
  } else {
    // Three inline columns (Support | DPS | Waitlist) so the field row
    // fills Discord's full embed width instead of leaving the 3rd column
    // empty. Waitlist always renders (even at 0) to keep the 3-col shape.
    const waitlistValue = waitlist.length > 0
      ? waitlist
          .map((s, i) => `\`#${i + 1}\` ${getClassEmoji(s.characterClass) || "•"} **${s.characterName}** · ${s.characterItemLevel}`)
          .join("\n")
      : "-";
    embed.addFields(
      { name: t("raid-schedule.board.supportHeader", lang, { n: support.length, slots: event.supSlots }), value: buildColumn(support, event.supSlots, lang), inline: true },
      { name: t("raid-schedule.board.dpsHeader", lang, { n: dps.length, slots: event.dpsSlots }), value: buildColumn(dps, event.dpsSlots, lang), inline: true },
      { name: t("raid-schedule.board.waitlistHeader", lang, { n: waitlist.length }), value: waitlistValue, inline: true }
    );
    const rsvp = renderRsvpLine(event.signups, lang);
    if (rsvp) {
      embed.addFields({ name: t("raid-schedule.board.rsvpHeader", lang), value: rsvp, inline: false });
    }
  }

  embed.setFooter({
    text: t(`raid-schedule.board.footer.${event.status}`, lang, {
      id: String(event._id || "").slice(-4) || "----",
    }),
  });
  return embed;
}

// "🤔 Có thể N · names   ❌ Vắng N · names" - tentative + absent only
// (late holds a slot, so it shows in the comp columns, not here).
function renderRsvpLine(signups, lang) {
  const by = (status) => (signups || []).filter((s) => s.status === status);
  const parts = [];
  const tentative = by("tentative");
  const absent = by("absent");
  // Names are appended OUTSIDE the t() call so the row renders correctly
  // even before the locale keys land (t supplies only the label prefix).
  if (tentative.length) {
    parts.push(`${t("raid-schedule.board.rsvpTentative", lang)} ${tentative.length} · ${tentative.map((s) => s.characterName).join(", ")}`);
  }
  if (absent.length) {
    parts.push(`${t("raid-schedule.board.rsvpAbsent", lang)} ${absent.length} · ${absent.map((s) => s.characterName).join(", ")}`);
  }
  return parts.join("   ");
}

/**
 * Build the board's component rows. Returns [] for frozen
 * (cleared/cancelled) events so the buttons are stripped.
 * @param {object} event - RaidEvent
 * @param {{ActionRowBuilder: Function, ButtonBuilder: Function, ButtonStyle: object, lang?: string}} deps
 * @returns {Array} discord.js ActionRow instances (0 or 3 rows)
 */
function buildScheduleComponents(event, { ActionRowBuilder, ButtonBuilder, ButtonStyle, lang = "vi" }) {
  if (event.status === "cleared" || event.status === "cancelled") return [];
  const id = String(event._id);
  const locked = event.status === "locked";

  const btn = (action, label, style, disabled = false) =>
    new ButtonBuilder()
      .setCustomId(`rse:${action}:${id}`)
      .setLabel(label)
      .setStyle(style)
      .setDisabled(disabled);

  // Row 1: everyone-facing status + room (5 buttons, the Discord row cap).
  // Row 2: help + lead's Manage entry. Lock/unlock + End live INSIDE the
  // Manage menu now (kept off the board to keep it to 2 tidy rows).
  const statusRow = new ActionRowBuilder().addComponents(
    btn("join", t("raid-schedule.btn.join", lang), ButtonStyle.Success, locked),
    btn("rsvp:late", t("raid-schedule.btn.late", lang), ButtonStyle.Secondary, locked),
    btn("rsvp:tentative", t("raid-schedule.btn.tentative", lang), ButtonStyle.Secondary, locked),
    btn("rsvp:absent", t("raid-schedule.btn.absent", lang), ButtonStyle.Secondary),
    btn("room", t("raid-schedule.btn.room", lang), ButtonStyle.Secondary)
  );
  const utilityRow = new ActionRowBuilder().addComponents(
    btn("help", t("raid-schedule.btn.help", lang), ButtonStyle.Secondary),
    btn("manage", t("raid-schedule.btn.manage", lang), ButtonStyle.Secondary)
  );
  return [statusRow, utilityRow];
}

module.exports = {
  buildScheduleEmbed,
  buildScheduleComponents,
  // exported for unit tests
  renderRsvpLine,
};
