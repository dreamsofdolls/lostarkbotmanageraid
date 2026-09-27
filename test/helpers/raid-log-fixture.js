"use strict";

const assert = require("node:assert/strict");
const { EmbedBuilder, AttachmentBuilder, MessageFlags } = require("discord.js");
const { createRaidLogCommand } = require("../../bot/handlers/raid/log");

function logEntry(id, raidKey = "kazeros", timestamp = 100) {
  return { id, url: `https://lostark.bible/logs/${id}`, character: "Qiylyn", raidKey,
    raidLabel: raidKey, gate: "G2", difficulty: "Hard", timestamp, duration: 90000 };
}

function fixture({ lang = "vi", accounts = [], logs = [logEntry("new"), logEntry("old", "kazeros", 90), logEntry("serca", "serca", 80)],
  hasMore = false, sessionMs, maxSessions, now } = {}) {
  const events = [];
  let payload, modal, failure, verifyFailure, beforeVerify, beforeOpen, loadFailure;
  let failEdit = false;
  let userDoc = { language: lang, accounts };
  const catalog = { profile: { name: "Qiylyn" }, logs, page: 1, hasMore };
  const logCatalog = {
    open: async name => { events.push(["open", name]); await beforeOpen?.(); if (verifyFailure) throw verifyFailure; return catalog; },
    verify: async () => { events.push("verify"); await beforeVerify?.(); if (verifyFailure) throw verifyFailure; },
    more: async current => { events.push("more"); return { ...current, hasMore: false, logs: [...current.logs, logEntry("extra", "horizon", 70)] }; },
  };
  const editReply = async next => {
    events.push("edit"); if (failEdit) throw new Error("Discord unavailable");
    payload = { ...payload, ...next }; return { id: "message" };
  };
  const handlers = createRaidLogCommand({
    EmbedBuilder, AttachmentBuilder, MessageFlags, UI: { colors: { progress: 0xfee75c } }, log: {},
    logCatalog, sessionMs, maxSessions, now,
    loadCaller: async id => { events.push(["load", id]); if (loadFailure) throw loadFailure; return userDoc; },
    resolveStoredLanguage: async (id, doc) => { assert.equal(doc, userDoc); return lang; },
    captureRaidLog: async (url, options) => {
      events.push(["capture", url, options]); if (failure) throw failure;
      return { url, title: "Kazeros G2", header: "Hard\nKazeros G2", summary: "Duration: 1:30 · Total DMG: 100 · Total DPS: 1",
        playerCount: 8, partyCount: 2, filename: "capture.png", buffer: Buffer.from("png") };
    },
  });
  const slash = { user: { id: "author" }, guildId: "guild", channelId: "channel",
    deferReply: async options => { assert.deepEqual(options, {}); events.push("ack"); }, editReply };
  function component(action, value, overrides = {}) {
    const controls = payload.components.flatMap(row => row.toJSON().components);
    const customId = action === "submit" ? modal.custom_id : controls.find(c => c.custom_id.endsWith(`:${action}`)).custom_id;
    const interaction = {
      user: { id: "someone-else" }, guildId: "guild", channelId: "channel", message: { id: "message" },
      customId, values: value === undefined ? undefined : [value],
      isButton: () => ["search", "bracketed", "detail"].includes(action),
      isStringSelectMenu: () => ["character", "tab", "raid", "log"].includes(action),
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

module.exports = { fixture, logEntry, captures, controls };
