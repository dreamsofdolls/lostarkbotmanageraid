"use strict";

const { t, getUserLanguage } = require("../../services/i18n");
const { parseRaidLogSource } = require("../../services/raid-log/source");
const { RaidLogError, raidLogErrorCode } = require("../../services/raid-log/errors");

function buildSummaryFields(summary, lang) {
  const text = String(summary || "");
  const duration = text.match(/Duration:\s*([\d:]+)(?:\s*(\+[\d:]+))?/);
  const values = {
    duration: duration?.slice(1).filter(Boolean).join(" "),
    totalDamage: text.match(/Total DMG:\s*([\d,]+)/)?.[1],
    totalDps: text.match(/Total DPS:\s*([\d,]+)/)?.[1],
  };
  return Object.entries(values)
    .filter(([, value]) => value)
    .map(([key, value]) => ({ name: t(`raid-log.fields.${key}`, lang), value, inline: true }));
}

function createRaidLogCommand({
  EmbedBuilder, AttachmentBuilder, MessageFlags, UI, User, captureRaidLog, findLatestRaidLog,
  resolveStoredLanguage = id => getUserLanguage(id, { UserModel: User }),
  log = console,
}) {
  function replyError(interaction, error, lang) {
    const code = raidLogErrorCode(error);
    log.warn?.(`[raid-log] ${code}: ${error.message}`);
    return interaction.editReply({
      content: t(`raid-log.errors.${code}`, lang), embeds: [], files: [],
      allowedMentions: { parse: [] },
    });
  }

  async function handleRaidLogCommand(interaction) {
    const url = interaction.options.getString("url");
    const character = interaction.options.getString("character");
    const view = interaction.options.getString("view") || "team";
    let source;
    let invalid;
    try { source = parseRaidLogSource({ character, url }); } catch (error) { invalid = error; }
    // Acknowledge before database or browser work. Successful captures are public
    // in the caller's channel, and malformed input is private to the caller.
    await interaction.deferReply(invalid ? { flags: MessageFlags.Ephemeral } : {});
    const lang = await resolveStoredLanguage(interaction.user.id);
    if (invalid) return replyError(interaction, invalid, lang);
    try {
      const selected = source.character ? await findLatestRaidLog(source.character) : source;
      const result = await captureRaidLog(selected.url, { view });
      if (result.buffer.length > (interaction.attachmentSizeLimit || 8 * 1024 * 1024)) {
        throw new RaidLogError("too_large");
      }
      const description = [];
      if (selected.character) description.push(t("raid-log.latest", lang, { character: selected.character }));
      description.push(t("raid-log.description", lang, {
        players: result.playerCount, parties: result.partyCount, view: t(`raid-log.views.${view}`, lang),
      }));
      const embed = new EmbedBuilder()
        .setColor(UI.colors.progress)
        .setTitle(`🧪 TEST · ${result.title}`.slice(0, 256))
        .setURL(result.url)
        .setDescription(description.join("\n"))
        .addFields({ name: t("raid-log.details", lang), value: result.header.replace(/\n{2,}/g, "\n").slice(0, 1024) })
        .addFields(buildSummaryFields(result.summary, lang))
        .setImage(`attachment://${result.filename}`)
        .setFooter({ text: t("raid-log.footer", lang) });
      await interaction.editReply({
        embeds: [embed], files: [new AttachmentBuilder(result.buffer, { name: result.filename })],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      // Keep browser internals, URLs from redirects and filesystem paths out of Discord.
      return replyError(interaction, error, lang);
    }
  }
  return { handleRaidLogCommand };
}

module.exports = { createRaidLogCommand, buildSummaryFields };
