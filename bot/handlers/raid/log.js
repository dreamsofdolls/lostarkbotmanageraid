"use strict";

const { randomBytes } = require("node:crypto");
const { getUserLanguage, t } = require("../../services/i18n");
const { parseRaidLogSource, normalizeCharacterName } = require("../../services/raid-log/source");
const { RaidLogError, raidLogErrorCode } = require("../../services/raid-log/errors");
const { MAX_IMAGE_BYTES } = require("../../services/raid-log/capture");
const { buildLogComponents, buildLogEmbeds, PAGE_SIZE } = require("./log-view");
const { tabsForPlayer } = require("../../services/raid-log/tabs");
const { rosterChoices, pickerOptions, buildLogPicker, buildLogSearchModal } = require("./log-picker");
const { buildRaidLogNotice, buildRevokedNotice } = require("./log-notices");
const { buildRecentLoading, buildRecentView, recentOptions } = require("./log-recent-view");

const PICKER_ACTION_TYPES = { search: "isButton", recent_open: "isButton", character: "isStringSelectMenu", submit: "isModalSubmit" };
const RECENT_ACTION_TYPES = { picker: "isButton", recent_refresh: "isButton", recent: "isStringSelectMenu" };
const LOG_ACTION_TYPES = {
  tab_prev: "isButton", tab_next: "isButton", bracketed: "isButton", reset: "isButton",
  player: "isStringSelectMenu", raid: "isStringSelectMenu", log: "isStringSelectMenu", tab: "isStringSelectMenu",
};
// Each stage accepts only its own controls.
const ACTION_TYPES = { picker: PICKER_ACTION_TYPES, recent: RECENT_ACTION_TYPES, log: LOG_ACTION_TYPES };

function createRaidLogCommand({
  EmbedBuilder, AttachmentBuilder, MessageFlags, UI, User, captureRaidLog, logCatalog, recentLogs,
  loadCaller = id => User.findOne({ discordId: id }).select(
    "language accounts.accountName accounts.characters.name accounts.characters.class accounts.characters.itemLevel"
    + " accounts.characters.bibleSerial accounts.characters.bibleCid accounts.characters.bibleRid"
    + " accounts.characters.publicLogDisabled accounts.characters.publicLogDisabledAt",
  ).lean(),
  resolveStoredLanguage = (id, userDoc) => getUserLanguage(id, { UserModel: User, userDoc }),
  sessionMs = 15 * 60_000, maxSessions = 64, now = Date.now, log = console,
}) {
  const sessions = new Map();
  const embeds = (state, result) => buildLogEmbeds(state, result, { EmbedBuilder, UI });
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
    try {
      const captureStarted = now();
      const result = await captureRaidLog(state.selected.url, {
        view: "full", tab: state.tab, bracketed: state.bracketed, player: state.player, useCache: true, refresh,
      });
      const captureMs = now() - captureStarted;
      const limit = interaction.attachmentSizeLimit || MAX_IMAGE_BYTES;
      if (result.images.some(image => image.buffer.length > limit)) throw new RaidLogError("too_large");
      const { images, ...metadata } = result;
      state.result = { ...metadata, images: images.map(image => ({ filename: image.filename })) };
      const uploadStarted = now();
      const message = await interaction.editReply({
        content: null, embeds: embeds(state, state.result), components: buildLogComponents(state),
        attachments: [], files: images.map(image => new AttachmentBuilder(image.buffer, { name: image.filename })), allowedMentions: { parse: [] },
      });
      log.info(`[raid-log] rendered id=${state.selected.id} player=${state.player?.id || "team"} tab=${state.tab} images=${images.length} bracketed=${state.bracketed} cached=${Boolean(result.cached)} queueMs=${result.queueMs || 0} captureMs=${captureMs} uploadMs=${now() - uploadStarted}`);
      return message;
    } catch (error) {
      // The notice links the log being opened; the session still points at the previous one.
      error.logUrl = state.selected.url;
      throw error;
    }
  }

  async function handleRaidLogCommand(interaction) {
    await interaction.deferReply({});
    let rosterUnavailable = false;
    const userDoc = await loadCaller(interaction.user.id).catch(error => {
      log.warn(`[raid-log] roster lookup failed: ${error.message}`);
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
      const code = raidLogErrorCode(error);
      log.warn(`[raid-log] ${code}: ${error.message}`);
      await interaction.editReply({ content: null, embeds: [buildRaidLogNotice(code, { EmbedBuilder, lang })],
        components: [], files: [], attachments: [], allowedMentions: { parse: [] } });
    } finally { if (state) state.busy = false; }
  }

  async function selectCharacter(interaction, state, action) {
    if (action === "search") return interaction.showModal(buildLogSearchModal(state));
    if (action === "recent_open") {
      // The button is on the picker only when there are saved characters.
      if (!state.choices.length) throw new RaidLogError("invalid_selection");
      return showRecent(interaction, state, false);
    }
    if (action === "submit") return openLog(interaction, state, interaction.fields.getTextInputValue("character"));
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
    await openLog(interaction, state, choice.name);
  }

  // Opens the panel on the character's newest log, or on logId when given.
  async function openLog(interaction, state, name, logId) {
    const source = parseRaidLogSource({ character: name });
    const catalog = await logCatalog.open(source.character, { logId });
    const selected = logId ? catalog.logs.find(entry => entry.id === logId) : catalog.logs[0];
    if (!selected) throw new RaidLogError("invalid_selection");
    const logIndex = catalog.logs.filter(entry => entry.raidKey === selected.raidKey).findIndex(entry => entry.id === selected.id);
    const next = {
      ...state, stage: "log", revision: state.revision + 1, expires: now() + sessionMs, catalog, selected,
      tab: "damage", player: null, bracketed: true, raidPage: 0, logPage: Math.floor(logIndex / PAGE_SIZE), choices: [], recent: null,
    };
    await render(interaction, next);
    Object.assign(state, next);
  }

  async function showRecent(interaction, state, refresh) {
    const accounts = (await loadCaller(state.ownerId))?.accounts;
    // The loading card has no controls; busy stays held until the result replaces it.
    await interaction.editReply(buildRecentLoading(state, recentLogs.countCandidates(accounts), { EmbedBuilder, UI }));
    try {
      const recent = await recentLogs.load(state.ownerId, accounts, { refresh });
      const next = { ...state, stage: "recent", recent, revision: state.revision + 1, expires: now() + sessionMs };
      await interaction.editReply(buildRecentView(next, { EmbedBuilder, UI }));
      Object.assign(state, next);
    } catch (error) {
      // Put the card the loading card replaced back, controls included, before the notice.
      const previous = state.stage === "recent" ? buildRecentView(state, { EmbedBuilder, UI }) : buildLogPicker(state, { EmbedBuilder, UI });
      await interaction.editReply(previous);
      throw error;
    }
  }

  async function handleRecent(interaction, state, action) {
    if (action === "recent_refresh") return showRecent(interaction, state, true);
    if (action === "picker") {
      const next = { ...state, stage: "picker", recent: null, revision: state.revision + 1 };
      await interaction.editReply(buildLogPicker(next, { EmbedBuilder, UI }));
      Object.assign(state, next);
      return;
    }
    const value = interaction.values?.[0];
    if (!recentOptions(state).some(option => option.value === value)) throw new RaidLogError("invalid_selection");
    const entry = state.recent.entries[Number(value)];
    // As with the roster menu, the character must still be in the caller's saved roster.
    const fresh = await loadCaller(state.ownerId);
    const name = normalizeCharacterName(entry.character);
    if (!rosterChoices(fresh?.accounts).some(choice => normalizeCharacterName(choice.name) === name)) {
      throw new RaidLogError("roster_changed");
    }
    await openLog(interaction, state, entry.character, entry.id);
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
    tab: (state, value) => ({ tab: value }),
    player: (state, value) => ({ player: state.result.players?.find(entry => entry.id === value) || null, tab: "damage" }),
  };

  async function applySelection(state, action, value) {
    const next = { ...state, revision: state.revision + 1 };
    const control = buildLogComponents(state).flatMap(row => row.toJSON().components)
      .find(component => component.custom_id.endsWith(`:${action}`));
    if (!control || control.disabled || (control.options && !control.options.some(option => option.value === value))) throw new RaidLogError("invalid_selection");
    if (Object.hasOwn(viewSelections, action)) return { ...next, ...viewSelections[action](state, value) };
    if (value === "__refresh") {
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
    const reject = code => interaction.reply({
      embeds: [buildRaidLogNotice(code, { EmbedBuilder, lang: state?.lang || "vi", owner: state && `<@${state.ownerId}>` })],
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
    });
    if (!state || state.expires <= now()) return reject("expired");
    if (state.guildId !== interaction.guildId || state.channelId !== interaction.channelId || state.messageId !== interaction.message?.id) return reject("invalid_selection");
    if (state.ownerId !== interaction.user.id) return reject("owner_only");
    if (state.busy) return reject("panel_busy");
    if (String(state.revision) !== revision) return reject("stale");
    const actionTypes = ACTION_TYPES[state.stage];
    const validAction = Object.hasOwn(actionTypes, action) && interaction[actionTypes[action]]?.();
    if (!validAction) return reject("invalid_selection");
    // The public message is controlled by its caller throughout. Claim before any await.
    state.busy = true;
    const started = now();
    let waitingShown = false;
    try {
      if (action !== "search") {
        // Acknowledge and show progress in one request, before any DB/Bible work.
        await interaction.update({ content: t("raid-log.waiting", state.lang), allowedMentions: { parse: [] } });
        waitingShown = true;
      }
      if (state.stage === "picker") return await selectCharacter(interaction, state, action);
      if (state.stage === "recent") return await handleRecent(interaction, state, action);
      const value = interaction.values?.[0];
      // Refresh re-reads the log list itself, so it skips the separate privacy check.
      const refreshing = action === "raid" && value === "__refresh";
      if (!refreshing) await logCatalog.verify(state.catalog);
      const next = await applySelection(state, action, value);
      const changed = next.tab !== state.tab || next.bracketed !== state.bracketed || next.selected.id !== state.selected.id || next.player?.id !== state.player?.id;
      if (changed || refreshing) await render(interaction, next, refreshing);
      else await interaction.editReply({ content: null, embeds: embeds(next, next.result), components: buildLogComponents(next), allowedMentions: { parse: [] } });
      Object.assign(state, next);
    } catch (error) {
      const code = raidLogErrorCode(error);
      log.warn(`[raid-log] ${code}: ${error.message}`);
      if (state.stage === "log" && ["logs_private", "no_logs", "character_mismatch"].includes(code)) {
        sessions.delete(id);
        await interaction.editReply({
          content: null, embeds: [buildRevokedNotice(code, { EmbedBuilder, lang: state.lang, character: state.catalog.profile.name })],
          attachments: [], files: [], components: buildLogComponents(state, true), allowedMentions: { parse: [] },
        });
      } else {
        if (waitingShown) await interaction.editReply({ content: null }).catch(cleanupError => {
          log.warn(`[raid-log] waiting notice cleanup: ${cleanupError.message}`);
        });
        const payload = {
          embeds: [buildRaidLogNotice(code, { EmbedBuilder, lang: state.lang, logUrl: error.logUrl })],
          flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        };
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      }
    } finally {
      state.busy = false;
      log.info(`[raid-log] interaction action=${action} elapsedMs=${now() - started}`);
    }
  }
  return { handleRaidLogCommand, handleRaidLogComponent };
}

module.exports = { createRaidLogCommand };
