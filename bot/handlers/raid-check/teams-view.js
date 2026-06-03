/**
 * handlers/raid-check/teams-view.js
 * "📋 Đội đã xếp" surface for /raid-check: a dropdown listing every active
 * raid-schedule event in the guild (any Manager's), and the per-event detail
 * (board comp + bus turn plan) shown ephemerally when a Manager picks one.
 *
 * This is the ONLY place raid-check reaches into the raid-schedule domain, so
 * the coupling (RaidEvent + the board embed builders) is isolated here rather
 * than leaking into all-mode.js - mirrors how task-view-ui.js isolates tasks.
 *
 * Discord constraints driving the shape:
 *   - a select option's label/description are PLAIN TEXT (no <t:..>/<#..>), so
 *     the dropdown carries raid + counts + lead name; time/room live in the detail.
 *   - a select caps at 25 options and a message at 5 rows, so > 25 events spill
 *     into extra dropdowns up to the row budget (the caller passes maxRows).
 */

"use strict";

const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");
const {
  shapeAllOwnedBoardRows,
  chunkBoardOptions,
  SWITCHER_OPTION_CAP,
} = require("../../services/raid/schedule/owned-boards");
const { t } = require("../../services/i18n");

// Selects in this surface share the `raid-check-all-teams:<chunkIndex>` prefix;
// the chunk index only keeps custom-ids unique across overflow dropdowns - the
// chosen eventId rides in the select VALUE, so the handler ignores the index.
const TEAMS_SELECT_PREFIX = "raid-check-all-teams:";

/**
 * Build the /raid-check teams-view UI service.
 * @param {object} deps - injected dependencies (discord.js builders +
 *   MessageFlags, UI palette, RaidEvent + User models, the two schedule board
 *   embed builders, truncateText · see destructure)
 * @returns {{TEAMS_SELECT_PREFIX: string, loadActiveEventsForTeams: Function, buildTeamsRows: Function, handleRaidCheckTeamsSelect: Function}}
 */
function createTeamsViewUi(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    MessageFlags,
    UI,
    RaidEvent,
    User,
    buildScheduleEmbed,
    buildTurnPlanEmbed,
    truncateText,
  } = deps;

  // Best-effort display names for the boards' creators, one query for all of
  // them, so the dropdown can say who arranged each team. Missing names just
  // fall back to the no-lead option line - never blocks the render.
  async function resolveLeadNames(creatorIds) {
    const map = new Map();
    const unique = [...new Set((creatorIds || []).map(String).filter(Boolean))];
    if (unique.length === 0 || !User) return map;
    try {
      const docs = await User.find({ discordId: { $in: unique } })
        .select("discordId discordDisplayName discordGlobalName discordUsername")
        .lean();
      for (const d of docs) {
        map.set(
          String(d.discordId),
          d.discordDisplayName || d.discordGlobalName || d.discordUsername || null,
        );
      }
    } catch (error) {
      console.warn("[raid-check teams] lead-name resolve failed:", error?.message || error);
    }
    return map;
  }

  /**
   * Snapshot of the guild's active raid-schedule events, shaped for the
   * dropdown + enriched with lead display names. Taken ONCE when /raid-check
   * opens (the detail is re-fetched live on pick), so re-renders don't re-query.
   * @param {{guildId: string}} args
   * @returns {Promise<Array>} shaped rows (+ leadName), [] on error / none
   */
  async function loadActiveEventsForTeams({ guildId }) {
    if (!RaidEvent || !guildId) return [];
    let events;
    try {
      events = await RaidEvent.find({ guildId, status: { $in: ["open", "locked"] } })
        .sort({ startAt: 1 })
        .lean();
    } catch (error) {
      console.warn("[raid-check teams] event query failed:", error?.message || error);
      return [];
    }
    const rows = shapeAllOwnedBoardRows(events, ""); // no "current" board in raid-check
    const leadNames = await resolveLeadNames(rows.map((r) => r.creatorId));
    return rows.map((row) => ({ ...row, leadName: leadNames.get(String(row.creatorId)) || null }));
  }

  function teamOption(row, lang) {
    const raidLabel = getRaidModeLabel(row.raidKey, row.modeKey, lang);
    const descKey = row.leadName ? "raid-check.teams.optionDesc" : "raid-check.teams.optionDescNoLead";
    return {
      label: truncateText(row.title || raidLabel, 100),
      value: row.eventId,
      emoji: "🗓️",
      description: truncateText(
        t(descKey, lang, {
          raid: raidLabel,
          comp: row.compCount,
          size: row.partySize,
          wait: row.waitlistCount,
          lead: row.leadName || "",
        }),
        100,
      ),
    };
  }

  /**
   * Build the teams dropdown row(s). One select per 25-event chunk, capped to
   * maxRows (Discord's 5-row-per-message limit minus the rows already used).
   * Returns [] when there are no events. Logs the dropped count if chunks
   * exceed maxRows (no silent truncation).
   * @param {{shapedEvents: Array, maxRows: number, disabled?: boolean, lang?: string}} args
   * @returns {Array} ActionRow instances (0..maxRows)
   */
  function buildTeamsRows({ shapedEvents, maxRows, disabled = false, lang = "vi" }) {
    const events = Array.isArray(shapedEvents) ? shapedEvents : [];
    const budget = Math.max(0, Number(maxRows) || 0);
    if (events.length === 0 || budget < 1) return [];

    const chunks = chunkBoardOptions(events, SWITCHER_OPTION_CAP);
    const shown = chunks.slice(0, budget);
    if (chunks.length > shown.length) {
      const dropped = chunks.slice(budget).reduce((n, c) => n + c.length, 0);
      console.warn(
        `[raid-check teams] row budget ${budget} < ${chunks.length} chunks; ${dropped} events not shown`,
      );
    }
    const multi = shown.length > 1;

    return shown.map((chunk, chunkIdx) => {
      const base = chunkIdx * SWITCHER_OPTION_CAP;
      const placeholder = multi
        ? t("raid-check.teams.placeholderRange", lang, { a: base + 1, b: base + chunk.length })
        : t("raid-check.teams.placeholderSingle", lang, { n: events.length });
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${TEAMS_SELECT_PREFIX}${chunkIdx}`)
          .setPlaceholder(truncateText(placeholder, 150))
          .setDisabled(disabled)
          .addOptions(chunk.map((row) => teamOption(row, lang))),
      );
    });
  }

  /**
   * A Manager picked an event: show its comp + turn plan as two embeds in one
   * ephemeral reply (re-fetched live so counts/turns are current). Ephemeral so
   * the spot-check never lands in the public /raid-check transcript.
   * @param {object} interaction - the select-menu component interaction
   * @param {string} eventId - chosen event id (the select value)
   * @param {string} lang - the clicking Manager's language (ephemeral = viewer's lang)
   * @returns {Promise<void>}
   */
  async function handleRaidCheckTeamsSelect(interaction, eventId, lang) {
    let event = null;
    try {
      event = eventId ? await RaidEvent.findById(eventId) : null;
    } catch {
      event = null;
    }
    if (!event || (event.status !== "open" && event.status !== "locked")) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-check.teams.eventGoneTitle", lang),
            description: t("raid-check.teams.eventGoneDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }
    await interaction.reply({
      embeds: [
        buildScheduleEmbed(event, { EmbedBuilder, UI, lang }),
        buildTurnPlanEmbed(event, { EmbedBuilder, UI, lang }),
      ],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  return {
    TEAMS_SELECT_PREFIX,
    loadActiveEventsForTeams,
    buildTeamsRows,
    handleRaidCheckTeamsSelect,
  };
}

module.exports = { createTeamsViewUi };
