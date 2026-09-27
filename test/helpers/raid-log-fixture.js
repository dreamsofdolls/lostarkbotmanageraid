"use strict";

const assert = require("node:assert/strict");
const { EmbedBuilder, AttachmentBuilder, MessageFlags } = require("discord.js");
const { createRaidLogCommand } = require("../../bot/handlers/raid/log");
const { CLASS_EMOJI_MAP } = require("../../bot/models/Class");
const { silentLog } = require("./silent-log");

// Team figures as capture.js reads them from Bible (log zEn59i4), three of its eight rows.
const PLAYERS = [
  { id: "1-0", party: 1, row: 0, label: "1760 Qiylyn", className: "Aeromancer", badges: { bracketed: [99], normalized: [98] },
    damageShare: 24.6, counters: 3, stagger: 3500, dps: 1.06e9, ndps: 385.7e6, contribution: 63.6, buffedShare: null },
  { id: "1-3", party: 1, row: 3, label: "1755 Canameo", className: "Bard", badges: { bracketed: [82, 91], normalized: [82, 91] },
    damageShare: 0.1, counters: 2, stagger: 2000, dps: 4.2e6, ndps: 3.6e6, contribution: 51.1, buffedShare: 31.8 },
  { id: "2-1", party: 2, row: 1, label: "1746 Slayer #1", className: "Slayer", badges: { bracketed: [80], normalized: [69] },
    damageShare: 11, counters: 0, stagger: 3600, dps: 473.2e6, ndps: 211.3e6, contribution: 55.3, buffedShare: null },
];

// Sets class icons for one test and restores them after it.
function withClassIcons(t, icons) {
  const saved = Object.fromEntries(Object.keys(icons).map(name => [name, CLASS_EMOJI_MAP[name]]));
  Object.assign(CLASS_EMOJI_MAP, icons);
  t.after(() => Object.assign(CLASS_EMOJI_MAP, saved));
}

function logEntry(id, raidKey = "kazeros", timestamp = 100) {
  return { id, url: `https://lostark.bible/logs/${id}`, character: "Qiylyn", raidKey,
    raidLabel: raidKey, gate: "G2", difficulty: "Hard", timestamp, duration: 90000 };
}

function fixture({ lang = "vi", accounts = [], logs = [logEntry("new"), logEntry("old", "kazeros", 90), logEntry("serca", "serca", 80)],
  profile = { name: "Qiylyn" }, hasMore = false, sessionMs, maxSessions, now, transformCapture = result => result } = {}) {
  const events = [];
  let payload, modal, failure, verifyFailure, beforeVerify, beforeOpen, loadFailure;
  let failEdit = false;
  let userDoc = { language: lang, accounts };
  const catalog = { profile, logs, page: 1, hasMore };
  const logCatalog = {
    open: async name => { events.push(["open", name]); await beforeOpen?.(); if (verifyFailure) throw verifyFailure; return catalog; },
    verify: async () => { events.push("verify"); await beforeVerify?.(); if (verifyFailure) throw verifyFailure; },
    more: async current => { events.push("more"); return { ...current, hasMore: false, logs: [...current.logs, logEntry("extra", "horizon", 70)] }; },
    refresh: async current => { events.push("refresh"); if (verifyFailure) throw verifyFailure; return { ...current, logs: [logEntry("latest", "kazeros", 200), ...current.logs] }; },
  };
  const editReply = async next => {
    events.push("edit"); if (failEdit) throw new Error("Discord unavailable");
    payload = { ...payload, ...next }; return { id: "message" };
  };
  const handlers = createRaidLogCommand({
    EmbedBuilder, AttachmentBuilder, MessageFlags, UI: { colors: { progress: 0xfee75c, neutral: 0x5865f2 } }, log: silentLog,
    logCatalog, sessionMs, maxSessions, now,
    loadCaller: async id => { events.push(["load", id]); if (loadFailure) throw loadFailure; return userDoc; },
    resolveStoredLanguage: async (id, doc) => { assert.equal(doc, userDoc); return lang; },
    captureRaidLog: async (url, options) => {
      events.push(["capture", url, options]); if (failure) throw failure;
      const images = options.player
        ? ["top", "bottom"].map(part => ({ filename: `${part}.png`, buffer: Buffer.from(part) }))
        : [{ filename: "capture.png", buffer: Buffer.from("png") }];
      return transformCapture({ url, title: "Kazeros G2", header: "Hard\nKazeros G2", summary: "Duration: 1:30 · Total DMG: 100 · Total DPS: 1",
        playerCount: 8, partyCount: 2, images,
        hasBreakdown: options.player?.id !== "2-1",
        ...(options.player ? { links: [{ title: "View Character Profile", url: "https://lostark.bible/character/NA/Qiylyn" }] } : {}),
        players: PLAYERS });
    },
  });
  const slash = { user: { id: "author" }, guildId: "guild", channelId: "channel",
    deferReply: async options => { assert.deepEqual(options, {}); events.push("ack"); }, editReply };
  function component(action, value, overrides = {}) {
    const controls = payload.components.flatMap(row => row.toJSON().components);
    const customId = action === "submit" ? modal.custom_id
      : controls.find(c => c.custom_id.endsWith(`:${action}`))?.custom_id || controls[0].custom_id.replace(/:[^:]+$/, `:${action}`);
    const interaction = {
      user: { id: "someone-else" }, guildId: "guild", channelId: "channel", message: { id: "message" },
      customId, values: value === undefined ? undefined : [value],
      isButton: () => ["search", "bracketed", "detail", "reset", "refresh", "tab_prev", "tab_next", "tab_label"].includes(action),
      isStringSelectMenu: () => ["character", "player", "raid", "log"].includes(action),
      isModalSubmit: () => action === "submit",
      fields: { getTextInputValue: name => { assert.equal(name, "character"); return value; } },
      showModal: async next => { modal = next.toJSON(); events.push(["modal", modal]); },
      deferUpdate: async () => { events.push("ack-update"); interaction.deferred = true; }, editReply,
      reply: async reply => events.push(["reply", reply]), followUp: async reply => events.push(["followUp", reply]),
      ...overrides,
    };
    return interaction;
  }
  const open = () => handlers.handleRaidLogCommand(slash);
  const click = interaction => handlers.handleRaidLogComponent(interaction);
  const owner = (action, value, overrides) => component(action, value, { user: slash.user, ...overrides });
  const search = async (name = "Qiylyn") => { await click(owner("search")); await click(owner("submit", name)); };
  return {
    events, handlers, slash, component, owner, open, search, click, run: async () => { await open(); await search(); },
    get payload() { return payload; }, get modal() { return modal; },
    set failure(error) { failure = error; }, set verifyFailure(error) { verifyFailure = error; },
    set beforeVerify(fn) { beforeVerify = fn; }, set failEdit(value) { failEdit = value; },
    set beforeOpen(fn) { beforeOpen = fn; },
    set userDoc(value) { userDoc = value; }, set loadFailure(value) { loadFailure = value; },
  };
}
const captures = f => f.events.filter(x => Array.isArray(x) && x[0] === "capture");
const controls = f => f.payload.components.map(row => row.toJSON().components[0]);
const control = (f, action) => f.payload.components.flatMap(row => row.toJSON().components).find(c => c.custom_id.endsWith(`:${action}`));

// Title and description of the notice card a reply, follow-up or edit carries.
function noticeText(payload) {
  const { title, description } = payload.embeds[0].toJSON();
  return `${title}\n${description}`;
}

module.exports = { fixture, logEntry, captures, controls, control, noticeText, withClassIcons };
