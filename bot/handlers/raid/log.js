"use strict";

const { randomBytes } = require("node:crypto");
const { t, getUserLanguage } = require("../../services/i18n");
const { parseRaidLogSource } = require("../../services/raid-log/source");
const { RaidLogError, raidLogErrorCode } = require("../../services/raid-log/errors");
const { buildSummaryFields, buildLogComponents, buildLogEmbed } = require("./log-view");

function createRaidLogCommand({
  EmbedBuilder, AttachmentBuilder, MessageFlags, UI, User, captureRaidLog, logCatalog,
  resolveStoredLanguage = id => getUserLanguage(id, { UserModel: User }),
  sessionMs = 15 * 60_000, maxSessions = 64, now = Date.now, log = console,
}) {
  const sessions = new Map();
  const embed = (state, result) => buildLogEmbed(state, result, { EmbedBuilder, UI });
  function errorText(error, lang) {
    const code = raidLogErrorCode(error);
    log.warn?.(`[raid-log] ${code}: ${error.message}`);
    return t(`raid-log.errors.${code}`, lang);
  }
  function remember(state) {
    for (const [id, entry] of sessions) if (entry.expires <= now() && !entry.busy) sessions.delete(id);
    if (sessions.size >= maxSessions) {
      const oldest = [...sessions.values()].find(entry => !entry.busy);
      if (!oldest) throw new RaidLogError("busy");
      sessions.delete(oldest.id);
    }
    sessions.set(state.id, state);
  }
  async function render(interaction, state) {
    const result = await captureRaidLog(state.selected.url, {
      view: "full", tab: state.tab, bracketed: state.bracketed, useCache: true,
    });
    if (result.buffer.length > (interaction.attachmentSizeLimit || 8 * 1024 * 1024)) throw new RaidLogError("too_large");
    const { buffer, ...metadata } = result;
    state.result = metadata; // Only the byte-limited capture cache retains image buffers.
    const message = await interaction.editReply({
      content: null, embeds: [embed(state, result)], components: buildLogComponents(state),
      attachments: [], files: [new AttachmentBuilder(buffer, { name: result.filename })], allowedMentions: { parse: [] },
    });
    log.info?.(`[raid-log] rendered id=${state.selected.id} tab=${state.tab} bracketed=${state.bracketed} cached=${Boolean(result.cached)}`);
    return message;
  }

  async function handleRaidLogCommand(interaction) {
    let source;
    let invalid;
    try { source = parseRaidLogSource({ character: interaction.options.getString("character") }); }
    catch (error) { invalid = error; }
    await interaction.deferReply(invalid ? { flags: MessageFlags.Ephemeral } : {});
    const language = resolveStoredLanguage(interaction.user.id).catch(() => "vi");
    let state;
    try {
      if (invalid) throw invalid;
      const catalog = await logCatalog.open(source.character);
      state = {
        id: randomBytes(8).toString("hex"), revision: 0, expires: now() + sessionMs, busy: true,
        guildId: interaction.guildId, channelId: interaction.channelId,
        lang: await language, catalog, selected: catalog.logs[0], tab: "damage", bracketed: true, raidPage: 0, logPage: 0,
      };
      remember(state);
      const message = await render(interaction, state);
      state.messageId = message.id;
    } catch (error) {
      if (state) sessions.delete(state.id);
      await interaction.editReply({ content: errorText(error, await language), embeds: [], components: [], files: [], attachments: [], allowedMentions: { parse: [] } });
    } finally { if (state) state.busy = false; }
  }

  async function applySelection(state, action, value) {
    const next = { ...state, revision: state.revision + 1 };
    if (action === "bracketed") return { ...next, bracketed: !state.bracketed };
    const rows = buildLogComponents(state).map(row => row.toJSON());
    const rowIndex = { tab: 0, raid: 1, log: 2 }[action];
    const control = rows[rowIndex]?.components[0];
    if (!control || control.disabled || !control.options.some(option => option.value === value)) throw new RaidLogError("invalid_selection");
    if (action === "tab") return { ...next, tab: value };
    if (value === "__more") return { ...next, catalog: await logCatalog.more(state.catalog) };
    const pageKey = action === "raid" ? "raidPage" : "logPage";
    if (value === "__prev" || value === "__next") return { ...next, [pageKey]: state[pageKey] + (value === "__next" ? 1 : -1) };
    const selected = action === "raid"
      ? state.catalog.logs.find(entry => entry.raidKey === value)
      : state.catalog.logs.find(entry => entry.id === value && entry.raidKey === state.selected.raidKey);
    if (!selected) throw new RaidLogError("invalid_selection");
    next.selected = selected;
    if (action === "raid") next.logPage = 0;
    return next;
  }

  async function handleRaidLogComponent(interaction) {
    const [, id, revision, action] = String(interaction.customId).split(":");
    const state = sessions.get(id);
    const reject = code => interaction.reply({ content: t(`raid-log.errors.${code}`, state?.lang || "vi"), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (!state || state.expires <= now()) return reject("expired");
    if (state.guildId !== interaction.guildId || state.channelId !== interaction.channelId || state.messageId !== interaction.message.id) return reject("invalid_selection");
    if (state.busy) return reject("panel_busy");
    if (String(state.revision) !== revision) return reject("stale");
    if (!["tab", "raid", "log", "bracketed"].includes(action)) return reject("invalid_selection");
    // Everyone in this channel may operate this panel. Claim before any await.
    state.busy = true;
    const started = now();
    try {
      await interaction.deferUpdate();
      await logCatalog.verify(state.catalog);
      const next = await applySelection(state, action, interaction.values?.[0]);
      const changed = next.tab !== state.tab || next.bracketed !== state.bracketed || next.selected.id !== state.selected.id;
      if (changed) await render(interaction, next);
      else await interaction.editReply({ embeds: [embed(next, next.result)], components: buildLogComponents(next), allowedMentions: { parse: [] } });
      Object.assign(state, next);
      log.info?.(`[raid-log] interaction action=${action} elapsedMs=${now() - started}`);
    } catch (error) {
      const code = raidLogErrorCode(error);
      if (["logs_private", "no_logs", "character_mismatch"].includes(code)) {
        sessions.delete(id);
        await interaction.editReply({ content: errorText(error, state.lang), embeds: [], attachments: [], files: [], components: buildLogComponents(state, true), allowedMentions: { parse: [] } });
      } else {
        const payload = { content: errorText(error, state.lang), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
        if (interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
      }
    } finally { state.busy = false; }
  }
  return { handleRaidLogCommand, handleRaidLogComponent };
}

module.exports = { createRaidLogCommand, buildSummaryFields };
