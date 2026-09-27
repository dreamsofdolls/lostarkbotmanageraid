"use strict";

const { randomBytes } = require("node:crypto");
const { t, getUserLanguage } = require("../../services/i18n");
const { parseRaidLogSource } = require("../../services/raid-log/source");
const { RaidLogError, raidLogErrorCode } = require("../../services/raid-log/errors");
const { buildSummaryFields, buildLogComponents, buildLogEmbeds } = require("./log-view");
const { tabsForPlayer } = require("../../services/raid-log/tabs");
const { rosterChoices, pickerOptions, buildLogPicker, buildLogSearchModal } = require("./log-picker");

const PICKER_ACTION_TYPES = { search: "isButton", character: "isStringSelectMenu", submit: "isModalSubmit" };
const LOG_ACTION_TYPES = {
  tab_prev: "isButton", tab_next: "isButton", bracketed: "isButton", reset: "isButton", refresh: "isButton",
  player: "isStringSelectMenu", raid: "isStringSelectMenu", log: "isStringSelectMenu",
};

function createRaidLogCommand({
  EmbedBuilder, AttachmentBuilder, MessageFlags, UI, User, captureRaidLog, logCatalog,
  loadCaller = id => User.findOne({ discordId: id }).select(
    "language accounts.accountName accounts.characters.name accounts.characters.class accounts.characters.itemLevel",
  ).lean(),
  resolveStoredLanguage = (id, userDoc) => getUserLanguage(id, { UserModel: User, userDoc }),
  sessionMs = 15 * 60_000, maxSessions = 64, now = Date.now, log = console,
}) {
  const sessions = new Map();
  const embeds = (state, result) => buildLogEmbeds(state, result, { EmbedBuilder, UI });
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
  async function render(interaction, state, refresh = false) {
    const result = await captureRaidLog(state.selected.url, {
      view: "full", tab: state.tab, bracketed: state.bracketed, player: state.player, useCache: true, refresh,
    });
    const images = result.images || [{ buffer: result.buffer, filename: result.filename }];
    if (images.some(image => image.buffer.length > (interaction.attachmentSizeLimit || 8 * 1024 * 1024))) throw new RaidLogError("too_large");
    const { buffer, images: capturedImages, ...metadata } = result;
    state.result = { ...metadata, images: images.map(({ buffer: bytes, ...image }) => image) };
    const message = await interaction.editReply({
      content: null, embeds: embeds(state, result), components: buildLogComponents(state),
      attachments: [], files: images.map(image => new AttachmentBuilder(image.buffer, { name: image.filename })), allowedMentions: { parse: [] },
    });
    log.info?.(`[raid-log] rendered id=${state.selected.id} player=${state.player?.id || "team"} tab=${state.tab} images=${images.length} bracketed=${state.bracketed} cached=${Boolean(result.cached)}`);
    return message;
  }

  async function handleRaidLogCommand(interaction) {
    await interaction.deferReply({});
    let rosterUnavailable = false;
    const userDoc = await loadCaller(interaction.user.id).catch(error => {
      log.warn?.(`[raid-log] roster lookup failed: ${error.message}`);
      rosterUnavailable = true;
      return null;
    });
    const lang = await resolveStoredLanguage(interaction.user.id, userDoc).catch(() => "vi");
    let state;
    try {
      state = {
        id: randomBytes(8).toString("hex"), revision: 0, expires: now() + sessionMs, busy: true,
        guildId: interaction.guildId, channelId: interaction.channelId,
        stage: "picker", ownerId: interaction.user.id, lang, page: 0,
        choices: rosterChoices(userDoc?.accounts), rosterUnavailable,
      };
      remember(state);
      const message = await interaction.editReply(buildLogPicker(state, { EmbedBuilder, UI }));
      state.messageId = message.id;
    } catch (error) {
      if (state) sessions.delete(state.id);
      await interaction.editReply({ content: errorText(error, lang), embeds: [], components: [], files: [], attachments: [], allowedMentions: { parse: [] } });
    } finally { if (state) state.busy = false; }
  }

  async function selectCharacter(interaction, state, action) {
    if (action === "search") return interaction.showModal(buildLogSearchModal(state));
    await interaction.deferUpdate();
    let name;
    if (action === "submit") {
      name = interaction.fields.getTextInputValue("character");
    } else {
      const value = interaction.values?.[0];
      if (!pickerOptions(state).some(option => option.value === value)) throw new RaidLogError("invalid_selection");
      if (value === "__prev" || value === "__next") {
        const next = { ...state, page: state.page + (value === "__next" ? 1 : -1), revision: state.revision + 1 };
        await interaction.editReply(buildLogPicker(next, { EmbedBuilder, UI }));
        Object.assign(state, next);
        return;
      }
      const choice = state.choices[Number(value)];
      // Resolve against the owner's latest saved roster, never another member's
      // shared/manager-accessible accounts or a stale array index.
      const fresh = await loadCaller(state.ownerId);
      if (!rosterChoices(fresh?.accounts).some(entry => entry.key === choice.key)) throw new RaidLogError("roster_changed");
      name = choice.name;
    }
    const source = parseRaidLogSource({ character: name });
    const catalog = await logCatalog.open(source.character);
    const next = {
      ...state, stage: "log", revision: state.revision + 1, expires: now() + sessionMs,
      catalog, selected: catalog.logs[0], tab: "damage", player: null, bracketed: true, raidPage: 0, logPage: 0, choices: [],
    };
    await render(interaction, next);
    Object.assign(state, next);
  }

  function stepTab(state, direction) {
    const tabs = Object.keys(tabsForPlayer(state.player, state.result));
    return { tab: tabs[tabs.indexOf(state.tab) + direction] };
  }
  const viewSelections = {
    bracketed: state => ({ bracketed: !state.bracketed }),
    reset: () => ({ player: null, tab: "damage", bracketed: true }),
    tab_prev: state => stepTab(state, -1),
    tab_next: state => stepTab(state, 1),
    player: (state, value) => ({ player: state.result.players?.find(entry => entry.id === value) || null, tab: "damage" }),
  };

  async function applySelection(state, action, value) {
    const next = { ...state, revision: state.revision + 1 };
    const control = buildLogComponents(state).flatMap(row => row.toJSON().components)
      .find(component => component.custom_id.endsWith(`:${action}`));
    if (!control || control.disabled || (control.options && !control.options.some(option => option.value === value))) throw new RaidLogError("invalid_selection");
    if (Object.hasOwn(viewSelections, action)) return { ...next, ...viewSelections[action](state, value) };
    if (action === "refresh") {
      const catalog = await logCatalog.refresh(state.catalog);
      // Keep the active historical log selectable even at the history limit.
      if (!catalog.logs.some(entry => entry.id === state.selected.id)) catalog.logs = [...catalog.logs.slice(0, -1), state.selected];
      const selected = catalog.logs.find(entry => entry.id === state.selected.id);
      return { ...next, catalog, selected, raidPage: 0, logPage: 0 };
    }
    if (value === "__more") return { ...next, catalog: await logCatalog.more(state.catalog) };
    const pageKey = action === "raid" ? "raidPage" : "logPage";
    if (value === "__prev" || value === "__next") return { ...next, [pageKey]: state[pageKey] + (value === "__next" ? 1 : -1) };
    const selected = action === "raid"
      ? state.catalog.logs.find(entry => entry.raidKey === value)
      : state.catalog.logs.find(entry => entry.id === value && entry.raidKey === state.selected.raidKey);
    if (!selected) throw new RaidLogError("invalid_selection");
    next.selected = selected;
    if (selected.id !== state.selected.id) { next.player = null; next.tab = "damage"; }
    if (action === "raid") next.logPage = 0;
    return next;
  }

  async function handleRaidLogComponent(interaction) {
    const [, id, revision, action] = String(interaction.customId).split(":");
    const state = sessions.get(id);
    const reject = code => interaction.reply({ content: t(`raid-log.errors.${code}`, state?.lang || "vi"), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (!state || state.expires <= now()) return reject("expired");
    if (state.guildId !== interaction.guildId || state.channelId !== interaction.channelId || state.messageId !== interaction.message?.id) return reject("invalid_selection");
    if (state.ownerId !== interaction.user.id) return reject("owner_only");
    if (state.busy) return reject("panel_busy");
    if (String(state.revision) !== revision) return reject("stale");
    const actionTypes = state.stage === "picker" ? PICKER_ACTION_TYPES : LOG_ACTION_TYPES;
    const validAction = Object.hasOwn(actionTypes, action) && interaction[actionTypes[action]]?.();
    if (!validAction) return reject("invalid_selection");
    // The public message is controlled by its caller throughout. Claim before any await.
    state.busy = true;
    const started = now();
    try {
      if (state.stage === "picker") return await selectCharacter(interaction, state, action);
      await interaction.deferUpdate();
      if (action !== "refresh") await logCatalog.verify(state.catalog);
      const next = await applySelection(state, action, interaction.values?.[0]);
      const changed = next.tab !== state.tab || next.bracketed !== state.bracketed || next.selected.id !== state.selected.id || next.player?.id !== state.player?.id;
      if (changed || action === "refresh") await render(interaction, next, action === "refresh");
      else await interaction.editReply({ embeds: embeds(next, next.result), components: buildLogComponents(next), allowedMentions: { parse: [] } });
      Object.assign(state, next);
      log.info?.(`[raid-log] interaction action=${action} elapsedMs=${now() - started}`);
    } catch (error) {
      const code = raidLogErrorCode(error);
      if (state.stage === "log" && ["logs_private", "no_logs", "character_mismatch"].includes(code)) {
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
