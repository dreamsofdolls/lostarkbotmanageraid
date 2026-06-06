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

const { t } = require("../../../../services/i18n");
const { getClassEmoji, isSupportClass } = require("../../../../models/Class");
const { getRaidRequirementMap } = require("../../../../domain/raid-catalog");
const { assignSlots } = require("../../../../services/raid/schedule/slots/slots");
const { resolveTurnMembers } = require("../../../../services/raid/schedule/turns");
const { getRaidModeLabel } = require("../../../../utils/raid/common/labels");
const { formatStartShortForLang } = require("../../../../utils/raid/schedule/artist-clock");

// Discord caps select option label/description at 100 chars; trim with an ellipsis.
function clip(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

// Lifecycle -> embed stripe color (mapped onto the shared UI palette).
function stripeColor(UI, status) {
  if (status === "cleared") return UI.colors.success;
  if (status === "cancelled") return UI.colors.danger;
  if (status === "locked") return UI.colors.warn || UI.colors.neutral;
  return UI.colors.progress;
}

// Universal HUD status code for the kicker/footer lines (language-independent,
// same spirit as the SUP/DPS chips).
const STATUS_CODE = { open: "OPEN", locked: "LOCKED", cleared: "DONE", cancelled: "CANCELLED" };

// Slot-fill gauge for the HUD header: one block per slot (▰ filled, ▱ empty),
// "" when there are no slots. Pure - unit-tested.
function renderGauge(filled, total) {
  const slots = Math.max(0, Number(total) || 0);
  if (slots === 0) return "";
  const on = Math.max(0, Math.min(Number(filled) || 0, slots));
  return "▰".repeat(on) + "▱".repeat(slots - on);
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

  // HUD operational kicker line (monospace, language-independent) above the
  // warm Artist prose lines.
  const descLines = [
    `\`${raidName} · iLvl ${event.minItemLevel}+\``,
    t("raid-schedule.board.startLine", lang, { rel: time.rel, abs: time.abs }),
    t("raid-schedule.board.leadLine", lang, { lead: `<@${event.creatorId}>` }),
  ];
  if (event.roomName) {
    descLines.push(
      t("raid-schedule.board.roomLine", lang, { room: event.roomName })
    );
  }
  // Slot-fill gauge in front of the progress line.
  const gauge = renderGauge(compCount, event.partySize);
  descLines.push(
    `${gauge ? `${gauge}  ` : ""}${t("raid-schedule.board.progress", lang, {
      n: compCount,
      size: event.partySize,
      waitlist: waitlist.length,
    })}`
  );

  const embed = new EmbedBuilder()
    .setColor(stripeColor(UI, event.status))
    .setAuthor({ name: "// SIGNUP BOARD" })
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
    text: `// ${STATUS_CODE[event.status] || ""} · ${t(`raid-schedule.board.footer.${event.status}`, lang, {
      id: String(event._id || "").slice(-4) || "----",
    })}`,
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
 * @param {{ActionRowBuilder: Function, ButtonBuilder: Function, ButtonStyle: object, StringSelectMenuBuilder?: Function, ownedBoardOptions?: Array, lang?: string}} deps
 *   ownedBoardOptions: shaped rows from owned-boards.shapeOwnedBoardOptions - the
 *   creator's active boards in this channel. When >= 2, a "Board khác của lead"
 *   switcher row is appended (needs StringSelectMenuBuilder).
 * @returns {Array} discord.js ActionRow instances (0, 2, or 3 rows)
 */
function buildScheduleComponents(event, {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ownedBoardOptions = [], lang = "vi",
}) {
  if (event.status === "cleared" || event.status === "cancelled") return [];
  const id = String(event._id);
  const locked = event.status === "locked";

  const btn = (action, label, style, disabled = false) =>
    new ButtonBuilder()
      .setCustomId(`rse:${action}:${id}`)
      .setLabel(label)
      .setStyle(style)
      .setDisabled(disabled);

  // Grouped by purpose so the board reads cleanly: row 1 is pure status
  // (join + the RSVP trio), row 2 is utility (room / help / Manage / Turn plan).
  // Lock/unlock + End live INSIDE the Manage menu (off the board).
  const statusRow = new ActionRowBuilder().addComponents(
    btn("join", t("raid-schedule.btn.join", lang), ButtonStyle.Success, locked),
    btn("rsvp:late", t("raid-schedule.btn.late", lang), ButtonStyle.Secondary, locked),
    btn("rsvp:tentative", t("raid-schedule.btn.tentative", lang), ButtonStyle.Secondary, locked),
    btn("rsvp:absent", t("raid-schedule.btn.absent", lang), ButtonStyle.Secondary)
  );
  // Turn plan moved off the board: leads reach it via `/raid-schedule-preview
  // show action:turnplan` (ephemeral dashboard); members see their own turns in
  // /raid-status "Raid của tôi". So the board keeps a clean 3-button utility row.
  const utilityRow = new ActionRowBuilder().addComponents(
    btn("room", t("raid-schedule.btn.room", lang), ButtonStyle.Secondary),
    btn("help", t("raid-schedule.btn.help", lang), ButtonStyle.Secondary),
    btn("manage", t("raid-schedule.btn.manage", lang), ButtonStyle.Secondary)
  );
  const rows = [statusRow, utilityRow];

  // Lead-only board switcher: only worth a whole row when the creator runs >= 2
  // boards in this channel, so a single-board lead never sees a one-option dropdown.
  if (StringSelectMenuBuilder && ownedBoardOptions.length >= 2) {
    rows.push(buildSwitcherRow(id, ownedBoardOptions, { ActionRowBuilder, StringSelectMenuBuilder, lang }));
  }
  return rows;
}

// The "🗓 Board khác của lead" select. Option labels carry the board title
// (falling back to the localized raid label); the description is plain text
// (`raid · X/Y · N chờ`) because select options never render <t:..>/<#..>.
// `action`/`placeholderKey` let the same shaping back two surfaces: the board's
// in-channel switcher (showpick) and the ephemeral turn-plan dashboard (showtp).
function buildSwitcherRow(currentId, ownedBoardOptions, {
  ActionRowBuilder, StringSelectMenuBuilder, lang,
  action = "showpick", placeholderKey = "raid-schedule.show.switchPlaceholder",
}) {
  const options = ownedBoardOptions.map((row) => {
    const raidLabel = getRaidModeLabel(row.raidKey, row.modeKey, lang);
    return {
      // shortId in the label so two same-raid boards are tell-apart-able.
      label: clip(`${row.title || raidLabel} · ${row.shortId}`, 100),
      value: row.eventId,
      emoji: "🗓️",
      description: clip(
        t("raid-schedule.show.optionDesc", lang, {
          raid: raidLabel,
          date: formatStartShortForLang(row.startAt, lang),
          comp: row.compCount,
          size: row.partySize,
          wait: row.waitlistCount,
        }),
        100,
      ),
      // Mark the board the switcher sits on so it reads as "đang xem".
      default: row.isCurrent,
    };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`rse:${action}:${currentId}`)
      .setPlaceholder(clip(t(placeholderKey, lang, { n: ownedBoardOptions.length }), 150))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options)
  );
}

// One member line: `{classEmoji} **{char}** · <@player> \`SUP|DPS\``. The chip
// is a universal role code, left untranslated so it renders the same in every
// locale. Mentions sit in an embed field value, so they render as names but
// never fire a notification (only `content` mentions ping).
function turnMemberLine(member) {
  const emoji = getClassEmoji(member.characterClass) || (member.role === "support" ? "🛡️" : "⚔️");
  const chip = member.role === "support" ? "SUP" : "DPS";
  return `${emoji} **${member.characterName}** · <@${member.discordId}> \`${chip}\``;
}

// One party's field value: `supN` support lines then `dpsN` dps lines, padding
// unfilled positions with "＋ trống" (board-style) so a half-built party still
// reads as "needs 1 more SUP". Chip on the empty line says which role is short.
function partyFieldValue(sups, dpss, supN, dpsN, lang) {
  const empty = t("raid-schedule.board.emptySlot", lang);
  const lines = [];
  for (let i = 0; i < supN; i += 1) {
    lines.push(sups[i] ? turnMemberLine(sups[i]) : `＋ *${empty}* \`SUP\``);
  }
  for (let i = 0; i < dpsN; i += 1) {
    lines.push(dpss[i] ? turnMemberLine(dpss[i]) : `＋ *${empty}* \`DPS\``);
  }
  const value = lines.join("\n") || empty;
  return value.length > 1024 ? `${value.slice(0, 1020)}…` : value;
}

/**
 * Build the standalone "turn plan" embed (signup-board frame: author kicker +
 * status stripe + footer). 8-man raids render each turn as TWO side-by-side
 * party fields (1 sup + 3 dps each) preceded by a full-width turn header that
 * forces a row break so Discord keeps Party 1 / Party 2 paired; 4-man raids
 * render one field per turn (1 sup + 3 dps). Unfilled positions show "＋ trống".
 * Party split is derived live (sup spread 1/party, dps 3/party) - the model
 * stores a flat memberIds list, not a party assignment. Same player may appear
 * across turns (bus model).
 * @param {object} event - RaidEvent (needs turns[], signups[], partySize, supSlots, dpsSlots)
 * @param {{EmbedBuilder: Function, UI: object, lang?: string}} deps
 * @returns {object} a discord.js EmbedBuilder instance
 */
function buildTurnPlanEmbed(event, { EmbedBuilder, UI, lang = "vi" }) {
  const raidName = rosterLabel(event.raidKey, event.modeKey);
  const time = discordTime(event.startAt);
  const turns = Array.isArray(event.turns) ? event.turns : [];
  const visibleMembers = new Set();
  // Header icons so turns / parties read at a glance (puzzle = turn; blue vs
  // orange diamond tell the two parties apart). TURN_RULE fills the turn
  // header's value - the old empty ZWSP left a visible "hở" gap under the name.
  const TURN_ICON = "🧩";
  const PARTY_ICONS = ["🔹", "🔸"];
  const TURN_RULE = "─".repeat(16);

  const desc = [
    t("raid-schedule.turnPlan.summary", lang, {
      raid: raidName,
      lead: `<@${event.creatorId}>`,
      rel: time.rel,
    }),
  ];
  if (turns.length === 0) desc.push(t("raid-schedule.turnPlan.empty", lang));

  const embed = new EmbedBuilder()
    .setColor(stripeColor(UI, event.status))
    .setAuthor({ name: "// TURN PLAN · BUS" })
    .setTitle(t("raid-schedule.turnPlan.title", lang, { title: event.title || raidName }))
    .setDescription(desc.join("\n"));

  // 8-man = 2 in-game parties (each 1 sup + 3 dps); anything else = single party.
  const partyCount = event.partySize === 8 ? 2 : 1;
  const supPerParty = Math.ceil((event.supSlots || 0) / partyCount);
  const dpsPerParty = Math.ceil((event.dpsSlots || 0) / partyCount);
  // Reserve the last field slot for the "… +N" overflow note (no silent caps).
  const FIELD_BUDGET = 24;
  const perTurnFields = partyCount === 1 ? 1 : 1 + partyCount; // 4-man: 1; 8-man: header + 2
  let usedFields = 0;
  let droppedTurns = 0;

  for (const turn of turns) {
    const members = resolveTurnMembers(event.signups, turn);
    for (const member of members) visibleMembers.add(member.discordId);
    if (usedFields + perTurnFields > FIELD_BUDGET) {
      droppedTurns += 1;
      continue;
    }
    const sups = members.filter((m) => m.role === "support");
    const dpss = members.filter((m) => m.role !== "support");

    if (partyCount === 1) {
      embed.addFields({
        name: `${TURN_ICON} ${turn.name}`,
        value: partyFieldValue(sups, dpss, supPerParty, dpsPerParty, lang),
        inline: true,
      });
    } else {
      // Full-width header (icon + a thin rule as its value) breaks the inline
      // row so P1/P2 stay paired - the rule also fills what used to be an empty
      // ZWSP gap under the turn name.
      embed.addFields({ name: `${TURN_ICON} ${turn.name}`, value: TURN_RULE, inline: false });
      for (let p = 0; p < partyCount; p += 1) {
        embed.addFields({
          name: `${PARTY_ICONS[p] || "\u25ab\ufe0f"} ${t("raid-schedule.turnPlan.party", lang, { n: p + 1 })}`,
          value: partyFieldValue(
            sups.slice(p * supPerParty, (p + 1) * supPerParty),
            dpss.slice(p * dpsPerParty, (p + 1) * dpsPerParty),
            supPerParty,
            dpsPerParty,
            lang,
          ),
          inline: true,
        });
      }
    }
    usedFields += perTurnFields;
  }
  if (droppedTurns > 0) {
    embed.addFields({
      name: "\u200b",
      value: t("raid-schedule.turnPlan.moreTurns", lang, { n: droppedTurns }),
      inline: false,
    });
  }

  if (turns.length > 0) {
    embed.setFooter({
      text: `// ${t("raid-schedule.turnPlan.footer", lang, {
        turns: turns.length,
        members: visibleMembers.size,
        id: String(event._id || "").slice(-4) || "----",
      })}`,
    });
  }
  return embed;
}

module.exports = {
  buildScheduleEmbed,
  buildScheduleComponents,
  buildTurnPlanEmbed,
  buildSwitcherRow,
  // exported for reuse (index.js HUD panels) + unit tests
  renderRsvpLine,
  renderGauge,
  STATUS_CODE,
};
