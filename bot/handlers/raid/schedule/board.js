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
const { resolveTurnMembers } = require("../../../services/raid/schedule/turns");
const { getRaidModeLabel } = require("../../../utils/raid/common/labels");
const { formatStartShortForLang } = require("../../../utils/raid/schedule/artist-clock");

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
  const utilityRow = new ActionRowBuilder().addComponents(
    btn("room", t("raid-schedule.btn.room", lang), ButtonStyle.Secondary),
    btn("help", t("raid-schedule.btn.help", lang), ButtonStyle.Secondary),
    btn("manage", t("raid-schedule.btn.manage", lang), ButtonStyle.Secondary),
    // Read-only turn-plan peek - anyone can click; replies ephemerally.
    btn("turnplan", t("raid-schedule.btn.turnPlan", lang), ButtonStyle.Secondary)
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
function buildSwitcherRow(currentId, ownedBoardOptions, { ActionRowBuilder, StringSelectMenuBuilder, lang }) {
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
      .setCustomId(`rse:showpick:${currentId}`)
      .setPlaceholder(clip(t("raid-schedule.show.switchPlaceholder", lang, { n: ownedBoardOptions.length }), 150))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options)
  );
}

/**
 * Build the standalone "turn plan" embed shown by /raid-schedule show.
 * One inline field per turn; each member line is
 * `{classEmoji} **{char}** · <@player> \`SUP|DPS\`` so it's clear who is
 * playing which character, which class, and which role (Cách 2 layout).
 * The same player can appear across turns (bus model).
 * @param {object} event - RaidEvent (needs turns[] + signups[])
 * @param {{EmbedBuilder: Function, UI: object, lang?: string}} deps
 * @returns {object} a discord.js EmbedBuilder instance
 */
function buildTurnPlanEmbed(event, { EmbedBuilder, UI, lang = "vi" }) {
  const raidName = rosterLabel(event.raidKey, event.modeKey);
  const time = discordTime(event.startAt);
  const turns = Array.isArray(event.turns) ? event.turns : [];
  const visibleMembers = new Set();

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

  for (const turn of turns) {
    const members = resolveTurnMembers(event.signups, turn);
    for (const member of members) visibleMembers.add(member.discordId);
    const lines = members.map((m) => {
      const emoji = getClassEmoji(m.characterClass) || (m.role === "support" ? "🛡️" : "⚔️");
      // SUP/DPS are universal role codes - left untranslated on purpose so
      // the chip renders identically across locales.
      const chip = m.role === "support" ? "SUP" : "DPS";
      return `${emoji} **${m.characterName}** · <@${m.discordId}> \`${chip}\``;
    });
    const value = lines.join("\n") || t("raid-schedule.board.emptySlot", lang);
    embed.addFields({
      name: turn.name,
      value: value.length > 1024 ? `${value.slice(0, 1020)}…` : value,
      inline: true,
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

// ─── Compact turn plan (Ops Brief · ANSI code block) ───────────────────
// A ```ansi block renders only in MESSAGE CONTENT (not embeds), so this
// returns a fenced string, not an embed. 8 fg colours only; gray (30) is
// reserved for chrome + "trống", names get one of the other 7 by a stable
// hash so a player keeps the same colour across turns.

const ANSI_GRAY = 30;
const ANSI_NAME_FG = [31, 32, 33, 34, 35, 36, 37];
const COMPACT_MAX_LEN = 1850; // Discord content cap is 2000; leave room for fences + footer.

/**
 * Stable ANSI fg code (31-37) for a name, so the same character is always the
 * same colour. Gray (30) is excluded (reserved for chrome / empty slots).
 * @param {string} name
 * @returns {number} an ANSI foreground code
 */
function ansiColorForName(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ANSI_NAME_FG[h % ANSI_NAME_FG.length];
}

function esc(code, text) {
  return `[${code}m${text}[0m`;
}

// One role column for a turn: filled names (coloured per character) padded to
// `slots` with gray "trống", joined by gray middots - so every turn shows the
// same number of cells and unfilled positions read like the signup board.
function compactRoleCells(members, slots, emptyLabel) {
  const cells = members.map((m) => esc(ansiColorForName(m.characterName), m.characterName));
  for (let i = members.length; i < slots; i += 1) cells.push(esc(ANSI_GRAY, emptyLabel));
  return cells.join(esc(ANSI_GRAY, " · "));
}

/**
 * Build the compact "thu nhỏ" turn plan as a ```ansi code-block string (message
 * content). Ops-Brief layout: header (raid + status), ROOM/ID (id = password,
 * gated), TIME/COMP, then one line per turn (DPS · DPS │ SUP). Empty slots show
 * "trống". Caps length to stay under Discord's 2000-char content limit.
 * @param {object} event - RaidEvent (needs turns[], signups[], room*, slots, status)
 * @param {{lang?: string, canSeeRoom?: boolean}} opts - canSeeRoom reveals the room password
 * @returns {string} a fenced ```ansi block ready to send as message content
 */
function buildCompactTurnPlan(event, { lang = "vi", canSeeRoom = false } = {}) {
  const raidLabel = getRaidModeLabel(event.raidKey, event.modeKey, lang);
  const statusCode = STATUS_CODE[event.status] || "";
  const { support, dps, waitlist } = assignSlots(event.signups, {
    supSlots: event.supSlots,
    dpsSlots: event.dpsSlots,
  });
  const compCount = support.length + dps.length;
  const empty = t("raid-schedule.board.emptySlot", lang);
  const turns = Array.isArray(event.turns) ? event.turns : [];

  const head = [];
  head.push(
    esc(33, `// OPS BRIEF · ${String(raidLabel).toUpperCase()}`) +
      (statusCode ? `   ${esc(31, `[${statusCode}]`)}` : ""),
  );
  head.push(esc(ANSI_GRAY, "═".repeat(42)));

  const roomName = event.roomName ? esc(36, event.roomName) : esc(ANSI_GRAY, "—");
  const idCell = !event.roomPassword
    ? esc(ANSI_GRAY, "—")
    : canSeeRoom
      ? esc(33, event.roomPassword)
      : esc(ANSI_GRAY, t("raid-schedule.compact.compOnly", lang));
  head.push(`  ${esc(ANSI_GRAY, "ROOM")}  ${roomName}    ${esc(ANSI_GRAY, "ID")}  ${idCell}`);

  const compStr = `${compCount}/${event.partySize}` + (waitlist.length ? ` · ⏳${waitlist.length}` : "");
  head.push(`  ${esc(ANSI_GRAY, "TIME")}  ${esc(37, formatStartShortForLang(event.startAt, lang))}    ${esc(ANSI_GRAY, "COMP")}  ${esc(37, compStr)}`);
  head.push(esc(ANSI_GRAY, "──────────────── SQUADS ──────────────────"));

  const body = [];
  let dropped = 0;
  let used = head.join("\n").length;
  if (turns.length === 0) {
    body.push(esc(ANSI_GRAY, `  ${t("raid-schedule.turnPlan.empty", lang)}`));
  } else {
    for (const turn of turns) {
      const members = resolveTurnMembers(event.signups, turn);
      const turnSup = members.filter((m) => m.role === "support");
      const turnDps = members.filter((m) => m.role !== "support");
      const line =
        `  ${esc(37, `S${turn.name}`)}  ${compactRoleCells(turnDps, event.dpsSlots, empty)}` +
        `  ${esc(ANSI_GRAY, "‖")} ${esc(ANSI_GRAY, "SUP")} ${compactRoleCells(turnSup, event.supSlots, empty)}`;
      if (used + line.length > COMPACT_MAX_LEN) {
        dropped += 1;
        continue;
      }
      body.push(line);
      used += line.length + 1;
    }
    if (dropped > 0) body.push(esc(ANSI_GRAY, `  … +${dropped}`));
  }

  const foot = esc(33, `// ${raidLabel}`) + esc(ANSI_GRAY, ` · #${String(event._id || "").slice(-6) || "------"}`);
  return ["```ansi", ...head, ...body, foot, "```"].join("\n");
}

module.exports = {
  buildScheduleEmbed,
  buildScheduleComponents,
  buildTurnPlanEmbed,
  buildCompactTurnPlan,
  ansiColorForName,
  // exported for reuse (index.js HUD panels) + unit tests
  renderRsvpLine,
  renderGauge,
  STATUS_CODE,
};
