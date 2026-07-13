/**
 * handlers/raid-status/my-raids.js
 * "Raid của tôi" surface for /raid-status: a dropdown listing the active
 * raid-schedule events the viewer is signed up for (self-join OR manager-
 * added), plus the per-event detail embed shown when they pick one. Pure
 * shaping/membership lives in services/raid/schedule/my-raids.js; this file
 * owns the Mongo query + the Discord render.
 *
 * Discord constraint: a select option's label/description are PLAIN TEXT -
 * `<t:..>` timestamps and `<#channel>` mentions do NOT render there. So the
 * dropdown option carries only role + turn count; the time, channel, room and
 * teammates (where markup renders) all live in the detail embed.
 */

"use strict";

const { t } = require("../../services/i18n");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");
const { getClassEmoji } = require("../../models/Class");
const { resolveTurnMembers } = require("../../services/raid/schedule/turns");
const { buildMyRaidDetail } = require("../../services/raid/schedule/boards/my-raids");

const MY_RAIDS_SELECT_ID = "status-myraids:select";

/**
 * Fetch the active (open/locked) events in this guild the viewer is in.
 * @param {{RaidEvent: object, guildId: string, discordId: string}} deps
 * @returns {Promise<Array>} lean RaidEvent docs sorted by start time (soonest first), [] on error
 */
async function findActiveEventsForUser({ RaidEvent, guildId, discordId }) {
  if (!RaidEvent || !guildId || !discordId) return [];
  try {
    return await RaidEvent.find({
      guildId,
      status: { $in: ["open", "locked"] },
      "signups.discordId": discordId,
    })
      .sort({ startAt: 1 })
      .lean();
  } catch (error) {
    console.warn("[raid-status my-raids] event query failed:", error?.message || error);
    return [];
  }
}

/**
 * Build the "Raid của tôi" dropdown row from shaped events.
 * @param {object} options
 * @param {Function} options.ActionRowBuilder
 * @param {Function} options.StringSelectMenuBuilder
 * @param {Function} options.truncateText - (str, max) => string
 * @param {Array} options.shapedEvents - from shapeMyRaidEvents (>= 1 entry)
 * @param {boolean} options.disabled
 * @param {string} options.lang
 * @returns {object} an ActionRowBuilder with the dropdown
 */
function buildMyRaidsRow({
  ActionRowBuilder,
  StringSelectMenuBuilder,
  truncateText,
  shapedEvents,
  disabled = false,
  lang = "vi",
}) {
  const selectOptions = shapedEvents.slice(0, 25).map((ev) => {
    const raidLabel = getRaidModeLabel(ev.raidKey, ev.modeKey, lang);
    const roleLabel = t(`raid-schedule.picker.role.${ev.role === "support" ? "support" : "dps"}`, lang);
    const desc = ev.turnCount > 0
      ? t("raid-status.myRaids.optionDescTurns", lang, { role: roleLabel, n: ev.turnCount })
      : t("raid-status.myRaids.optionDescNoTurns", lang, { role: roleLabel });
    return {
      label: truncateText(`${raidLabel} · ${ev.characterName}`, 100),
      value: ev.eventId,
      description: truncateText(desc, 100),
      emoji: "🗓️",
    };
  });

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(MY_RAIDS_SELECT_ID)
      .setPlaceholder(t("raid-status.myRaids.placeholder", lang, { n: shapedEvents.length }))
      .setDisabled(disabled)
      .addOptions(selectOptions),
  );
}

// One turn rendered as an inline field, member lines in the show format minus
// the @mention; the viewer's own line is marked in this personal view.
function turnFieldFor(turn, signups, viewerId, lang) {
  const members = resolveTurnMembers(signups, turn);
  const lines = members.map((m) => {
    const emoji = getClassEmoji(m.characterClass) || (m.role === "support" ? "🛡️" : "⚔️");
    const chip = m.role === "support" ? "SUP" : "DPS";
    const you = String(m.discordId) === String(viewerId)
      ? ` ${t("raid-status.myRaids.youTag", lang)}`
      : "";
    return `${emoji} **${m.characterName}** \`${chip}\`${you}`;
  });
  const value = lines.join("\n") || t("raid-status.myRaids.emptyTurn", lang);
  return {
    name: turn.name,
    value: value.length > 1024 ? `${value.slice(0, 1020)}…` : value,
    inline: true,
  };
}

/**
 * The personal detail embed for one event (ephemeral). Shows the viewer's
 * role, the room (only if they hold a slot), and their turn(s) + teammates.
 * @param {object} event - a RaidEvent doc
 * @param {string} viewerId - the clicker's discord id
 * @param {{EmbedBuilder: Function, UI: object, lang: string}} deps
 * @returns {object} an EmbedBuilder
 */
function buildMyRaidDetailEmbed(event, viewerId, { EmbedBuilder, UI, lang }) {
  const detail = buildMyRaidDetail(event, viewerId, {
    supSlots: event.supSlots,
    dpsSlots: event.dpsSlots,
  });
  const raidLabel = getRaidModeLabel(event.raidKey, event.modeKey, lang);
  const startSec = Math.floor(new Date(event.startAt).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setColor(UI.colors.neutral)
    .setAuthor({ name: "// MY RAID" })
    .setTitle(t("raid-status.myRaids.detailTitle", lang, { raid: raidLabel }))
    .setDescription(t("raid-status.myRaids.detailIntro", lang, {
      rel: `<t:${startSec}:R>`,
      abs: `<t:${startSec}:f>`,
      channel: `<#${event.channelId}>`,
    }));

  if (detail.signup) {
    const chip = detail.role === "support" ? "SUP" : "DPS";
    embed.addFields({
      name: t("raid-status.myRaids.roleField", lang),
      value: `**${detail.signup.characterName}** · ${detail.signup.characterItemLevel} · \`${chip}\` · ${detail.signup.status}`,
      inline: false,
    });
  }

  // Room is comp-only: a waitlist/absent viewer should not see it.
  if (detail.inComp) {
    const roomValue = event.roomName
      ? (event.roomPassword
          ? t("raid-status.myRaids.roomLine", lang, { room: event.roomName, password: event.roomPassword })
          : t("raid-status.myRaids.roomLineNoPassword", lang, { room: event.roomName }))
      : t("raid-status.myRaids.roomEmpty", lang);
    embed.addFields({ name: t("raid-status.myRaids.roomField", lang), value: roomValue, inline: false });
  }

  if (detail.turns.length > 0) {
    for (const turn of detail.turns) {
      embed.addFields(turnFieldFor(turn, event.signups, viewerId, lang));
    }
  } else {
    // In the comp but unscheduled, or only RSVP/waitlisted: tell them where they stand.
    const roleLabel = detail.role
      ? t(`raid-schedule.picker.role.${detail.role === "support" ? "support" : "dps"}`, lang)
      : "-";
    embed.addFields({
      name: t("raid-status.myRaids.turnsField", lang),
      value: t("raid-status.myRaids.noTurns", lang, { role: roleLabel }),
      inline: false,
    });
  }

  embed.setFooter({ text: `// ${t("raid-status.myRaids.detailFooter", lang, { id: String(event._id) })}` });
  return embed;
}

module.exports = {
  MY_RAIDS_SELECT_ID,
  findActiveEventsForUser,
  buildMyRaidsRow,
  buildMyRaidDetailEmbed,
};
