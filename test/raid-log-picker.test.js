"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, AttachmentBuilder, MessageFlags } = require("discord.js");
const { createRaidLogCommand } = require("../bot/handlers/raid/log");
const { createRaidInteractionRouter } = require("../bot/app/interaction-router-registry");
const { RaidLogError } = require("../bot/services/raid-log/errors");
const { getClassEmoji } = require("../bot/models/Class");
const { parseCustomEmoji } = require("../bot/utils/discord/emoji");
const { fixture, captures, controls, noticeText, withClassIcons } = require("./helpers/raid-log-fixture");
const { silentLog } = require("./helpers/silent-log");

const accounts = [
  { accountName: "Main roster", characters: [{ name: "Qiylyn", class: "Wardancer", itemLevel: 1760 }] },
  { accountName: "Second roster", characters: [{ name: "Altchar", class: "Artist", itemLevel: 1700 }] },
];
const eventCount = (f, name) => f.events.filter(event => event[0] === name).length;

test("opening card is public, acknowledges before loading and renders only search without saved characters", async () => {
  for (const lang of ["vi", "en", "jp"]) {
    for (const saved of [[], [{ accountName: "Empty", characters: [] }]]) {
      const f = fixture({ lang, accounts: saved }); await f.open();
      assert.equal(f.events[0], "ack");
      assert.equal(eventCount(f, "load"), 1);
      assert.equal(eventCount(f, "open"), 0);
      assert.equal(captures(f).length, 0);
      assert.deepEqual(controls(f).map(c => c.type), [2]);
      assert.match(controls(f)[0].custom_id, /:search$/);
      assert.equal(f.payload.components[0].toJSON().components.length, 1);
      assert.equal(f.payload.flags, undefined);
      assert.deepEqual(f.payload.allowedMentions, { parse: [] });
      const card = f.payload.embeds[0].toJSON();
      assert.equal(card.title, { vi: "📜 Raid log", en: "📜 Raid log", jp: "📜 レイドログ" }[lang]);
      assert.doesNotMatch(card.description, /<@/);
      assert.match(card.description, /\n-# /);
      assert.equal(card.footer, undefined);
      assert.doesNotMatch(JSON.stringify(f.payload), /raid-log\./);
    }
  }
});

test("roster card lists saved characters with class icon, roster and item level in all locales", async t => {
  withClassIcons(t, { Wardancer: "<:wardancer:333333333333333333>" });
  for (const lang of ["vi", "en", "jp"]) {
    const f = fixture({ lang, accounts }); await f.open();
    assert.deepEqual(controls(f).map(c => c.type), [2, 3]);
    assert.deepEqual(f.payload.components[0].toJSON().components.map(c => c.custom_id.split(":").at(-1)), ["search", "recent_open"]);
    const choices = controls(f)[1].options;
    assert.deepEqual(choices.map(c => c.label), ["Qiylyn", "Altchar"]);
    assert.equal(choices[0].description, { vi: "Roster Main roster · 1760", en: "Roster Main roster · 1760", jp: "ロスター Main roster · 1760" }[lang]);
    assert.deepEqual(choices[0].emoji, parseCustomEmoji(getClassEmoji("Wardancer")));
    assert.equal(choices[1].emoji, undefined);
    assert.equal(controls(f)[1].placeholder, { vi: "Chọn nhân vật trong roster", en: "Choose a roster character", jp: "ロスターのキャラクターを選択" }[lang]);
    assert.doesNotMatch(JSON.stringify(f.payload), /raid-log\./);
    assert.equal(captures(f).length, 0);
  }
});

test("production loader queries only the invoking Discord ID and reuses that document for language", async () => {
  const reads = []; let payload;
  const User = { findOne: query => {
    reads.push(query);
    return { select: fields => {
      assert.match(fields, /language.*accounts\.accountName.*accounts\.characters\.name/);
      assert.match(fields, /accounts\.characters\.bibleSerial.*accounts\.characters\.publicLogDisabledAt/);
      assert.doesNotMatch(fields, /registeredBy|assignedRaids|localSync|tasks/);
      return { lean: async () => ({ language: "en", accounts }) };
    } };
  } };
  const handler = createRaidLogCommand({ EmbedBuilder, AttachmentBuilder, MessageFlags, User,
    UI: { colors: { neutral: 0x5865f2 } }, log: silentLog });
  await handler.handleRaidLogCommand({ user: { id: "caller-only" }, guildId: "g", channelId: "c",
    deferReply: async () => assert.equal(reads.length, 0),
    editReply: async value => { payload = value; return { id: "m" }; },
  });
  assert.deepEqual(reads, [{ discordId: "caller-only" }]);
  assert.match(payload.embeds[0].toJSON().description, /from your roster below/);
  assert.equal(payload.components[1].toJSON().components[0].options.length, 2);
});

test("search opens an input modal immediately, then updates the same card into a public full log", async () => {
  const f = fixture(); await f.open(); f.events.length = 0;
  await f.click(f.owner("search"));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0][0], "modal");
  const input = f.modal.components[0].components[0];
  assert.equal(input.custom_id, "character"); assert.equal(input.required, true); assert.equal(input.max_length, 64);
  assert.equal(f.modal.title, "Tìm log theo tên");
  await f.click(f.owner("submit", " Qiylyn "));
  assert.deepEqual(f.events.slice(1, 4), ["ack-update", "edit", ["open", "Qiylyn"]]);
  assert.deepEqual(captures(f)[0][2], { view: "full", tab: "damage", bracketed: true, player: null, useCache: true, refresh: false });
  assert.equal(controls(f).length, 5);
  await f.click(f.owner("tab_next"));
  assert.equal(captures(f).at(-1)[2].tab, "party_buffs");
});

test("only the caller can open search, select a saved character or submit a modal", async () => {
  const f = fixture({ accounts }); await f.open(); await f.click(f.owner("search"));
  const before = f.events.length;
  for (const [action, value] of [["search"], ["character", "0"], ["submit", "Qiylyn"]]) {
    await f.click(f.component(action, value));
    assert.equal(f.events.at(-1)[0], "reply");
    assert.equal(f.events.at(-1)[1].flags, MessageFlags.Ephemeral);
    assert.match(noticeText(f.events.at(-1)[1]), /không phải của cậu/);
  }
  assert.equal(f.events.length, before + 3);
  assert.equal(captures(f).length, 0);
  for (const overrides of [{ channelId: "other" }, { guildId: "other" }, { message: { id: "other" } }, { message: null }]) {
    await f.click(f.owner("submit", "Qiylyn", overrides));
    assert.match(noticeText(f.events.at(-1)[1]), /không có trong/);
  }
  assert.equal(eventCount(f, "open"), 0);
});

test("saved selection reloads the caller, tolerates reordered rosters and rejects removed characters", async () => {
  const f = fixture({ accounts }); await f.open();
  f.userDoc = { accounts: [...accounts].reverse() };
  await f.click(f.owner("character", "0"));
  assert.deepEqual(f.events.filter(e => e[0] === "load"), [["load", "author"], ["load", "author"]]);
  assert.deepEqual(f.events.find(e => e[0] === "open"), ["open", "Qiylyn"]);

  const removed = fixture({ accounts }); await removed.open(); removed.userDoc = { accounts: [accounts[1]] };
  await removed.click(removed.owner("character", "0"));
  assert.equal(eventCount(removed, "open"), 0);
  assert.match(noticeText(removed.events.at(-1)[1]), /không còn trong roster/);
  assert.equal(controls(removed)[0].type, 2);
  await removed.search("Qiylyn"); assert.equal(captures(removed).length, 1);
});

test("long character lists paginate within Discord limits, reject forged values and invalidate stale modals", async () => {
  const f = fixture({ accounts: [{ accountName: "Roster", characters: Array.from({ length: 50 }, (_, i) => ({ name: `Char${i}`, class: "Bard", itemLevel: 1700 })) }] });
  await f.open(); await f.click(f.owner("search")); const oldModal = f.owner("submit", "Qiylyn");
  assert.equal(controls(f)[1].options.length, 23);
  assert.equal(controls(f)[1].placeholder, "Chọn nhân vật trong roster · 1/3");
  for (const value of ["__prev", "-1", "1e0", "23", "999", "forged"]) {
    await f.click(f.owner("character", value));
    assert.match(noticeText(f.events.at(-1)[1]), /không có trong/);
  }
  await f.click(f.owner("character", "__next"));
  assert.equal(controls(f)[1].options.length, 24);
  assert.equal(controls(f)[1].options[0].label, "Char22");
  await f.click(oldModal); assert.match(noticeText(f.events.at(-1)[1]), /cập nhật/);
  await f.click(f.owner("character", "__next"));
  assert.equal(controls(f)[1].options.length, 7);
  await f.click(f.owner("character", "49"));
  assert.deepEqual(f.events.find(e => e[0] === "open"), ["open", "Char49"]);
  assert.equal(captures(f).length, 1);
});

test("private log and rendering failures preserve a retryable picker without sharing an image", async () => {
  const f = fixture({ accounts }); await f.open();
  const pickerId = controls(f)[0].custom_id;
  f.verifyFailure = new RaidLogError("logs_private"); await f.search();
  assert.match(noticeText(f.events.at(-1)[1]), /Public Log/);
  assert.equal(captures(f).length, 0); assert.equal(controls(f)[0].custom_id, pickerId);
  f.verifyFailure = null; f.failure = new RaidLogError("browser_crashed"); await f.search();
  assert.equal(controls(f)[0].custom_id, pickerId); assert.equal(f.payload.files, undefined);
  f.failure = null; f.failEdit = true; await f.search();
  assert.equal(controls(f)[0].custom_id, pickerId);
  f.failEdit = false; f.failUpload = true; await f.search();
  assert.equal(f.payload.content, null); assert.equal(controls(f)[0].custom_id, pickerId);
  f.failUpload = false; await f.search(); assert.equal(controls(f).length, 5);
});

test("roster lookup failure keeps name search available without pretending there are no saved rosters", async () => {
  const f = fixture({ accounts }); f.loadFailure = new Error("database unavailable"); await f.open();
  assert.equal(controls(f).length, 1);
  assert.equal(f.payload.components[0].toJSON().components.length, 1);
  assert.match(f.payload.embeds[0].toJSON().description, /chưa tải được roster/);
  await f.search(); assert.equal(captures(f).length, 1);
});

test("overlapping selections cannot duplicate a capture and the old modal is stale after success", async () => {
  const f = fixture({ accounts }); await f.open(); await f.click(f.owner("search"));
  let release, started;
  const opening = new Promise(resolve => { started = resolve; });
  f.beforeOpen = () => new Promise(resolve => { release = resolve; started(); });
  const oldModal = f.owner("submit", "Qiylyn");
  const pending = f.click(oldModal);
  await opening;
  await f.click(f.owner("character", "0"));
  assert.match(noticeText(f.events.at(-1)[1]), /đang xử lý/);
  release(); await pending;
  assert.equal(eventCount(f, "open"), 1); assert.equal(captures(f).length, 1);
  await f.click(oldModal); assert.match(noticeText(f.events.at(-1)[1]), /cập nhật/);
  assert.equal(eventCount(f, "open"), 1);
});

test("expired modal and wrong interaction kinds cannot start a capture", async () => {
  let now = 0; const f = fixture({ accounts, now: () => now, sessionMs: 100 });
  await f.open(); await f.click(f.owner("search"));
  await f.click(f.owner("character", "0", { isStringSelectMenu: () => false, isModalSubmit: () => true }));
  assert.match(noticeText(f.events.at(-1)[1]), /không có trong/);
  now = 101; await f.click(f.owner("submit", "Qiylyn"));
  assert.match(noticeText(f.events.at(-1)[1]), /hết hạn/);
  assert.equal(eventCount(f, "open"), 0);
});

test("global router delivers raid-log search modal submissions and ignores unrelated modal IDs", async () => {
  const calls = [];
  const router = createRaidInteractionRouter({ MessageFlags, handlers: { handleRaidLogComponent: async i => calls.push(i.customId) } });
  for (const customId of ["raid-log:id:0:submit", "other:modal"]) {
    await router.handle({ customId, isChatInputCommand: () => false, isAutocomplete: () => false,
      isStringSelectMenu: () => false, isButton: () => false, isModalSubmit: () => true });
  }
  assert.deepEqual(calls, ["raid-log:id:0:submit"]);
});

test("picking a saved character shows it in the menu and locks the card until the log opens", async () => {
  const flat = rows => rows.flatMap(row => row.toJSON().components);
  const f = fixture({ accounts }); await f.open();
  const pickerControls = flat(f.payload.components);
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  f.beforeOpen = () => new Promise(resolve => { release = resolve; enter(); });
  const pending = f.click(f.owner("character", "1"));
  await entered;
  const waiting = flat(f.payload.components);
  assert.match(f.payload.content, /⏳.*Đã nhận yêu cầu/);
  assert.deepEqual(waiting.map(c => c.custom_id), pickerControls.map(c => c.custom_id));
  assert.ok(waiting.every(c => c.disabled), "search, recent logs and the roster menu are locked");
  const menu = waiting.find(c => c.custom_id.endsWith(":character"));
  assert.deepEqual(menu.options.filter(o => o.default).map(o => o.label), ["Altchar"]);
  release();
  await pending;
  assert.equal(f.payload.content, null);
  assert.ok(flat(f.payload.components).some(c => !c.disabled), "the opened panel is live");

  // A failed open puts the picker back as it was: live, with its placeholder.
  const g = fixture({ accounts }); await g.open();
  const before = g.payload.components;
  g.verifyFailure = new RaidLogError("timeout");
  await g.click(g.owner("character", "0"));
  assert.equal(g.payload.content, null);
  assert.deepEqual(g.payload.components, before);
  assert.ok(flat(g.payload.components).every(c => !c.disabled));
});
