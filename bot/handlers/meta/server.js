/**
 * handlers/meta/server.js
 * /raid-server for the application owner: `list` shows the servers the bot
 * is in, `leave` removes it from one after a confirmation card. The home
 * guild (GUILD_ID), the only guild with the slash commands, is never left.
 * Leaving keeps every stored record of the server.
 */

"use strict";

const { escapeMarkdown } = require("discord.js");

const { t, getUserLanguage } = require("../../services/i18n");
const { isApplicationOwner } = require("../../services/access/application-owner");
const { awaitAutoManageDecision } = require("../raid/auto-manage/core/confirmation");
const {
  NoticeKind,
  buildNoticeEmbed,
  deferEphemeralReply,
  editNotice,
} = require("../../utils/raid/common/shared");

const SUGGESTION_LIMIT = 25;
const CHOICE_TEXT_MAX = 100;
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;
const DESCRIPTION_MAX = 4096;
const LEAVE_PREFIX = "raid-server:leave:";
const LEAVE_CONFIRM_ID = `${LEAVE_PREFIX}confirm`;
const LEAVE_CANCEL_ID = `${LEAVE_PREFIX}cancel`;

const NOTICE_KINDS = Object.freeze({
  notOwner: NoticeKind.GUARD,
  notFound: NoticeKind.EXPIRED,
  protected: NoticeKind.GUARD,
  cancelled: NoticeKind.DONE,
  expired: NoticeKind.EXPIRED,
  done: NoticeKind.DONE,
  failed: NoticeKind.FAILURE,
});

// Title and description only: buildKeyedNotice also reads a Tip key, and
// these notices carry none.
function serverNotice(stem, lang, vars) {
  return {
    kind: NOTICE_KINDS[stem],
    title: t(`raid-server.${stem}Title`, lang, vars),
    description: t(`raid-server.${stem}Description`, lang, vars),
  };
}

// GUILD_ID may arrive padded or quoted (scripts/deploy-commands.js strips the
// same); a raw compare would leave the home guild unprotected.
function normalizeGuildId(value) {
  return String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

// An unavailable guild (a Discord outage at ready) carries only its id, with
// no name and no join date, so every label falls back to the id.
function guildName(guild) {
  return guild.name ?? guild.id;
}

// Server names are chosen by strangers: escape the markdown marks, plus the
// brackets of a masked link, which escapeMarkdown leaves alone.
function shownName(guild) {
  return escapeMarkdown(guildName(guild)).replace(/[[\]]/g, "\\$&");
}

// Discord's 100-character choice limit, without leaving half an emoji.
function cutChoiceText(value) {
  const cut = String(value).slice(0, CHOICE_TEXT_MAX);
  return TRAILING_HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut;
}

function joinedLabel(guild) {
  return Number.isFinite(guild.joinedTimestamp) ? `<t:${Math.floor(guild.joinedTimestamp / 1000)}:D>` : "?";
}

function byHomeThenName(homeGuildId) {
  return (a, b) => Number(b.id === homeGuildId) - Number(a.id === homeGuildId)
    || guildName(a).localeCompare(guildName(b));
}

// Lines past the description limit are dropped for one "+N more" line,
// whose room is reserved up front.
function buildListDescription(guilds, homeGuildId, lang) {
  const ordered = [...guilds].sort(byHomeThenName(homeGuildId));
  const room = DESCRIPTION_MAX - t("raid-server.list.more", lang, { count: ordered.length }).length - 1;
  const lines = [];
  let length = 0;
  for (const guild of ordered) {
    const line = t("raid-server.list.line", lang, {
      home: guild.id === homeGuildId ? "🏠 " : "",
      name: shownName(guild),
      id: guild.id,
      members: guild.memberCount ?? "?",
      joined: joinedLabel(guild),
    });
    if (length + line.length + 1 > room) {
      lines.push(t("raid-server.list.more", lang, { count: ordered.length - lines.length }));
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Build the /raid-server handlers.
 * @param {object} deps - discord.js builders, `UI`, the `User` model for the
 *   caller's language, `homeGuildId` (GUILD_ID) and an optional `isOwner` check
 * @returns {{ handleRaidServerCommand: Function, handleRaidServerAutocomplete: Function }}
 */
function createRaidServerCommand(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    UI,
    User,
    homeGuildId,
    isOwner = isApplicationOwner,
  } = deps;
  const homeId = normalizeGuildId(homeGuildId);

  // Checked in order before the card and again on the click, since the guild
  // list can change while the card waits. The owner is checked once per
  // command: it comes from the cached application and stays fixed meanwhile.
  const LEAVE_RULES = Object.freeze([
    { refusal: "notFound", refuses: ({ client, guildId }) => !client.guilds.cache.has(guildId) },
    { refusal: "protected", refuses: ({ guildId }) => guildId === homeId },
  ]);

  // The first LEAVE_RULES refusal for this guild, or null.
  function findLeaveRefusal(interaction, guildId) {
    const context = { client: interaction.client, guildId };
    return LEAVE_RULES.find(({ refuses }) => refuses(context))?.refusal ?? null;
  }

  // `list`: every guild in the cache, home first.
  async function showList(interaction, lang) {
    const guilds = [...interaction.client.guilds.cache.values()];
    const embed = new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(t("raid-server.list.title", lang, { count: guilds.length }))
      .setDescription(buildListDescription(guilds, homeId, lang));
    await interaction.editReply({ embeds: [embed] });
  }

  // The private card asking the owner to confirm, with Leave and Cancel.
  function buildConfirmCard(guild, lang) {
    const embed = buildNoticeEmbed(EmbedBuilder, {
      kind: NoticeKind.CONFIRM,
      title: t("raid-server.confirm.title", lang),
      description: t("raid-server.confirm.description", lang, { guild: shownName(guild) }),
      fields: [
        { name: t("raid-server.confirm.fields.server", lang), value: `**${shownName(guild)}**\n\`${guild.id}\``, inline: true },
        { name: t("raid-server.confirm.fields.members", lang), value: String(guild.memberCount ?? "?"), inline: true },
        { name: t("raid-server.confirm.fields.joined", lang), value: joinedLabel(guild), inline: true },
      ],
    });
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(LEAVE_CONFIRM_ID).setLabel(t("raid-server.buttons.confirm", lang)).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(LEAVE_CANCEL_ID).setLabel(t("raid-server.buttons.cancel", lang)).setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [buttons] };
  }

  // The confirmed click: re-check, then the one guild.leave() call, logged.
  async function finishLeave(interaction, guildId, lang) {
    const refusal = findLeaveRefusal(interaction, guildId);
    if (refusal) {
      await editNotice(interaction, EmbedBuilder, serverNotice(refusal, lang, { guild: guildId }), { components: [] });
      return;
    }
    const guild = interaction.client.guilds.cache.get(guildId);
    const logLabel = `${guildName(guild)} (${guild.id})`;
    const cardLabel = `${shownName(guild)} (${guild.id})`;
    try {
      await guild.leave();
    } catch (err) {
      console.error(`[raid-server] leave ${logLabel} failed:`, err?.message || err);
      await editNotice(interaction, EmbedBuilder, serverNotice("failed", lang, { guild: cardLabel }), { components: [] });
      return;
    }
    console.log(`[raid-server] left ${logLabel} by ${interaction.user.tag}`);
    await editNotice(interaction, EmbedBuilder, serverNotice("done", lang, { guild: cardLabel }), { components: [] });
  }

  // `leave`: refuse early, show the card, and leave only on a confirm click.
  async function confirmLeave(interaction, lang) {
    const guildId = interaction.options.getString("server", true).trim();
    const refusal = findLeaveRefusal(interaction, guildId);
    if (refusal) {
      await editNotice(interaction, EmbedBuilder, serverNotice(refusal, lang, { guild: guildId }));
      return;
    }
    await interaction.editReply(buildConfirmCard(interaction.client.guilds.cache.get(guildId), lang));
    const decision = await awaitAutoManageDecision({
      interaction,
      discordId: interaction.user.id,
      ComponentType,
      customIdPrefix: LEAVE_PREFIX,
      confirmId: LEAVE_CONFIRM_ID,
    });
    if (decision !== "confirm") {
      const stem = decision === "cancel" ? "cancelled" : "expired";
      await editNotice(interaction, EmbedBuilder, serverNotice(stem, lang), { components: [] });
      return;
    }
    await finishLeave(interaction, guildId, lang);
  }

  const SUBCOMMANDS = Object.freeze({ list: showList, leave: confirmLeave });

  // Both subcommands are owner-only; the check runs before either.
  async function handleRaidServerCommand(interaction) {
    await deferEphemeralReply(interaction);
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    if (!(await isOwner(interaction.client, interaction.user.id))) {
      await editNotice(interaction, EmbedBuilder, serverNotice("notOwner", lang));
      return;
    }
    await SUBCOMMANDS[interaction.options.getSubcommand()]?.(interaction, lang);
  }

  // Server suggestions for `leave server:`, for the owner only, home hidden.
  async function handleRaidServerAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name !== "server" || !(await isOwner(interaction.client, interaction.user.id))) {
        await interaction.respond([]);
        return;
      }
      const query = String(focused.value || "").trim().toLowerCase();
      const choices = [...interaction.client.guilds.cache.values()]
        .filter((guild) => guild.id !== homeId)
        .filter((guild) => guildName(guild).toLowerCase().includes(query) || guild.id.includes(query))
        .sort((a, b) => guildName(a).localeCompare(guildName(b)))
        .slice(0, SUGGESTION_LIMIT)
        .map((guild) => ({
          name: cutChoiceText(guild.name ? `${guild.name} · ${guild.id}` : guild.id),
          value: guild.id,
        }));
      await interaction.respond(choices);
    } catch (err) {
      console.warn("[raid-server] Server suggestions failed:", err?.message || err);
      await interaction.respond([]).catch(() => {});
    }
  }

  return { handleRaidServerCommand, handleRaidServerAutocomplete };
}

module.exports = { createRaidServerCommand };
