"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MessageFlags, ButtonStyle } = require("discord.js");
const { RaidLogError } = require("../bot/services/raid-log/errors");
const { createRaidInteractionRouter } = require("../bot/app/interaction-router-registry");
const { fixture, logEntry, captures, control, noticeText, withClassIcons } = require("./helpers/raid-log-fixture");

test("public panel puts one button row above the raid, log, player and tab menus in every locale", async () => {
  for (const lang of ["vi", "en", "jp"]) {
    const f = fixture({ lang });
    await f.run();
    assert.equal(f.events[0], "ack");
    const rows = f.payload.components.map(row => row.toJSON());
    assert.deepEqual(rows.map(row => row.components.map(c => c.type)), [[2, 2, 2, 2, 2], [3], [3], [3], [3]]);
    assert.deepEqual(rows.map(row => row.components.at(-1).custom_id.split(":").at(-1)), ["reset", "raid", "log", "player", "tab"]);
    const label = control(f, "tab_label");
    assert.deepEqual([label.label, label.emoji.name, label.disabled], ["Damage · 1/12", "⚔️", true]);
    assert.equal(control(f, "tab_prev").disabled, true);
    assert.equal(control(f, "tab_next").disabled, false);
    assert.deepEqual(control(f, "raid").options.map(o => o.value), ["kazeros", "serca", "__refresh"]);
    assert.deepEqual(control(f, "log").options.map(o => o.value), ["new", "old"]);
    assert.deepEqual(control(f, "player").options.map(o => o.value), ["__team", "1-0", "1-3", "2-1"]);
    assert.deepEqual([control(f, "bracketed").label, control(f, "bracketed").style], ["Bracketed", ButtonStyle.Primary]);
    assert.equal(control(f, "refresh"), undefined);
    assert.equal(control(f, "detail"), undefined);
    assert.doesNotMatch(JSON.stringify(f.payload), /raid-log\./);
  }
});

test("the caller can change tabs and Bracketed, with immediate ACK before privacy and rendering", async () => {
  const f = fixture();
  await f.run();
  const old = f.owner("tab_next");
  f.events.length = 0;
  await f.click(old);
  assert.deepEqual(f.events.slice(0, 3), ["ack-update", "edit", "verify"]);
  assert.equal(captures(f)[0][2].tab, "party_buffs");
  assert.equal(captures(f)[0][2].useCache, true);
  assert.equal(control(f, "tab_label").label, "Party Buffs · 2/12");
  await f.click(f.owner("bracketed"));
  assert.equal(captures(f).at(-1)[2].bracketed, false);
  assert.deepEqual([control(f, "bracketed").label, control(f, "bracketed").style], ["Normalized", ButtonStyle.Secondary]);
  await f.click(old);
  assert.match(noticeText(f.events.at(-1)[1]), /Bảng vừa được cập nhật/);
  assert.equal(f.events.at(-1)[1].flags, MessageFlags.Ephemeral);
});

test("other members cannot operate any log control or trigger Bible, capture or message edits", async () => {
  for (const lang of ["vi", "en", "jp"]) {
    const logs = [...Array.from({ length: 25 }, (_, i) => logEntry(`l${i}`, "kazeros", 100 - i)), logEntry("serca", "serca", 1)];
    const f = fixture({ lang, logs, hasMore: true });
    await f.run();
    const before = JSON.stringify(f.payload);
    f.events.length = 0;
    const attempts = [["tab_next"], ["raid", "serca"], ["log", "l1"], ["bracketed"], ["raid", "__more"],
      ["log", "__next"], ["player", "1-0"], ["reset"], ["raid", "__refresh"], ["tab", "tanked"]];
    for (const [action, value] of attempts) {
      await f.click(f.component(action, value));
      const [event, payload] = f.events.at(-1);
      assert.equal(event, "reply");
      assert.equal(payload.flags, MessageFlags.Ephemeral);
      assert.match(noticeText(payload), { vi: /không phải của cậu/, en: /isn't yours/, jp: /あなたのものではありません/ }[lang]);
      assert.match(noticeText(payload), /<@author>/);
    }
    assert.equal(f.events.length, 10);
    assert.equal(JSON.stringify(f.payload), before);
    await f.click(f.owner("bracketed"));
    assert.equal(captures(f).length, 1);
    assert.equal(captures(f)[0][2].bracketed, false);
  }
});

test("raid selection chooses its latest log, confines the log menu to that raid and rejects forged values", async () => {
  const f = fixture();
  await f.run();
  await f.click(f.owner("raid", "serca"));
  assert.equal(captures(f).at(-1)[1], "https://lostark.bible/logs/serca");
  assert.deepEqual(control(f, "log").options.map(x => x.value), ["serca"]);
  const before = captures(f).length;
  await f.click(f.owner("log", "new"));
  assert.equal(captures(f).length, before);
  await f.click(f.owner("raid", "empty-raid"));
  assert.equal(captures(f).length, before);
  await f.click(f.owner("detail"));
  assert.equal(captures(f).length, before);
  await f.click(f.owner("tab_next", undefined, { channelId: "different" }));
  assert.equal(captures(f).length, before);
  await f.click(f.owner("tab_next", undefined, { message: { id: "different" } }));
  assert.equal(captures(f).length, before);
});

test("load-more and menu pagination preserve the displayed image without recapturing or uploading", async () => {
  const f = fixture({ logs: Array.from({ length: 25 }, (_, i) => logEntry(`l${i}`, "kazeros", 100 - i)), hasMore: true });
  await f.run();
  assert.ok(control(f, "log").options.length <= 25);
  assert.equal(control(f, "log").options.at(-1).value, "__next");
  await f.click(f.owner("log", "__next"));
  assert.deepEqual(control(f, "log").options.map(x => x.value), ["l22", "l23", "l24", "__prev"]);
  await f.click(f.owner("log", "l23"));
  assert.equal(captures(f).at(-1)[1], "https://lostark.bible/logs/l23");
  const before = captures(f).length;
  await f.click(f.owner("raid", "__more"));
  assert.equal(captures(f).length, before);
  assert.ok(control(f, "raid").options.some(x => x.value === "horizon"));
  assert.ok(!control(f, "raid").options.some(x => x.value === "__more"));
});

test("private characters are blocked initially and changing to private revokes the existing panel before capture", async () => {
  const initial = fixture();
  initial.verifyFailure = new RaidLogError("logs_private");
  await initial.run();
  assert.equal(captures(initial).length, 0);
  assert.equal(initial.payload.components.length, 1);
  assert.match(noticeText(initial.events.at(-1)[1]), /Public Log/);
  const f = fixture();
  await f.run();
  f.verifyFailure = new RaidLogError("logs_private");
  const action = f.owner("tab_next");
  await f.click(action);
  assert.equal(captures(f).length, 1);
  assert.deepEqual(f.payload.attachments, []);
  assert.equal(f.payload.embeds.length, 1);
  assert.match(noticeText(f.payload), /Log của Qiylyn không còn public/);
  assert.ok(f.payload.components.every(row => row.toJSON().components.every(c => c.disabled)));
  await f.click(action);
  assert.match(noticeText(f.events.at(-1)[1]), /hết hạn/);
});

test("more than 25 raid choices paginate without losing raid selection or exposing unavailable logs", async () => {
  const f = fixture({ logs: Array.from({ length: 30 }, (_, i) => logEntry(`l${i}`, `raid${i}`, 100 - i)) });
  await f.run();
  assert.equal(control(f, "raid").options.length, 23);
  await f.click(f.owner("raid", "__next"));
  assert.equal(captures(f).length, 1);
  assert.equal(control(f, "raid").options.length, 11);
  await f.click(f.owner("raid", "raid29"));
  assert.deepEqual(control(f, "log").options.map(x => x.value), ["l29"]);
  assert.equal(captures(f).at(-1)[1], "https://lostark.bible/logs/l29");
});

test("simultaneous clicks do not overlap; capture and Discord failures leave committed controls unchanged", async () => {
  const f = fixture();
  await f.run();
  let release;
  f.beforeVerify = () => new Promise(resolve => { release = resolve; });
  const action = f.owner("tab_next");
  const pending = f.click(action);
  await f.click(f.owner("bracketed"));
  assert.match(noticeText(f.events.find(event => event[0] === "reply")[1]), /đang xử lý/);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await pending;
  f.beforeVerify = null;
  const retry = f.owner("bracketed");
  const current = control(f, "bracketed").label;
  f.failure = new RaidLogError("browser_crashed");
  await f.click(retry);
  assert.equal(control(f, "bracketed").label, current);
  f.failure = null;
  f.failEdit = true;
  await f.click(retry);
  assert.equal(control(f, "bracketed").label, current);
  f.failEdit = false;
  f.failUpload = true;
  await f.click(retry);
  assert.equal(f.payload.content, null);
  assert.equal(control(f, "bracketed").label, current);
  f.failUpload = false;
  await f.click(retry);
  assert.notEqual(control(f, "bracketed").label, current);
});

test("acknowledgement visibly shows waiting before Bible work and preserves the current images and controls", async () => {
  const f = fixture();
  await f.run();
  const previous = { embeds: f.payload.embeds, components: f.payload.components, files: f.payload.files };
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  f.beforeVerify = () => new Promise(resolve => { release = resolve; enter(); });
  const action = f.owner("tab_next");
  const pending = f.click(action);
  await entered;
  assert.equal(action.replied, true);
  assert.match(f.payload.content, /⏳.*Đã nhận yêu cầu/);
  assert.deepEqual({ embeds: f.payload.embeds, components: f.payload.components, files: f.payload.files }, previous);
  release();
  await pending;
  assert.equal(f.payload.content, null);
  f.beforeVerify = null;
  f.failure = new RaidLogError("timeout");
  const controlsBeforeFailure = f.payload.components;
  await f.click(f.owner("tab_next"));
  assert.equal(f.payload.content, null, "failed requests must not leave an indefinite waiting notice");
  assert.deepEqual(f.payload.components, controlsBeforeFailure);
  assert.match(noticeText(f.events.at(-1)[1]), /lâu|thời gian|timeout/i);
  f.failure = null;
  await f.click(f.owner("tab_next"));
  assert.equal(f.payload.content, null);
});

test("expired and evicted panels retain their explicit limits", async () => {
  let now = 0;
  const f = fixture({ sessionMs: 100, now: () => now, maxSessions: 1 });
  await f.run();
  const first = f.owner("tab_next");
  await f.run();
  await f.click(first);
  assert.match(noticeText(f.events.at(-1)[1]), /hết hạn/);
  const second = f.owner("tab_next");
  now = 101;
  await f.click(second);
  assert.match(noticeText(f.events.at(-1)[1]), /hết hạn/);
});

test("every selection captures a full tab; Bracketed persists within a panel and starts ON for each new panel", async () => {
  const f = fixture();
  await f.run();
  assert.equal(captures(f).at(-1)[2].bracketed, true);
  await f.click(f.owner("bracketed"));
  for (const [action, value] of [["tab_next"], ["log", "old"], ["raid", "serca"]]) {
    await f.click(f.owner(action, value));
    assert.equal(captures(f).at(-1)[2].bracketed, false);
  }
  await f.run();
  assert.equal(captures(f).at(-1)[2].bracketed, true);
  assert.equal(captures(f).at(-1)[2].tab, "damage");
  assert.equal(captures(f).length, 6);
  assert.ok(captures(f).every(([, , options]) => options.view === "full"));
});

test("a failed capture answers with a notice card linking the log it tried to open", async () => {
  const f = fixture();
  await f.run();
  f.failure = new RaidLogError("timeout");
  await f.click(f.owner("log", "old"));
  const [event, payload] = f.events.at(-1);
  assert.equal(event, "followUp");
  assert.equal(payload.flags, MessageFlags.Ephemeral);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.match(noticeText(payload), /Bible phản hồi quá lâu[\s\S]*\(https:\/\/lostark\.bible\/logs\/old\)/);
});

test("global router dispatches both raid-log dropdowns and buttons to the panel handler", async () => {
  let calls = 0;
  const router = createRaidInteractionRouter({ MessageFlags, handlers: { handleRaidLogComponent: async () => { calls++; } } });
  for (const select of [true, false]) {
    await router.handle({ customId: "raid-log:id:0:tab", isChatInputCommand: () => false, isAutocomplete: () => false,
      isStringSelectMenu: () => select, isButton: () => !select });
  }
  assert.equal(calls, 2);
});

test("the raid menu keeps load-older and refresh on every page within 25 options", async () => {
  const logs = Array.from({ length: 30 }, (_, i) => logEntry(`l${i}`, `raid${i}`, 100 - i));
  for (const hasMore of [false, true]) {
    const f = fixture({ logs, hasMore });
    await f.run();
    const tail = hasMore ? ["__more", "__refresh"] : ["__refresh"];
    let values = control(f, "raid").options.map(option => option.value);
    assert.equal(values.length, 21 + 1 + tail.length);
    assert.deepEqual(values.slice(21), ["__next", ...tail]);
    await f.click(f.owner("raid", "__next"));
    values = control(f, "raid").options.map(option => option.value);
    assert.deepEqual(values, [...logs.slice(21).map(log => log.raidKey), "__prev", ...tail]);
    assert.ok(values.length <= 25);
  }
});

test("the tab menu lists the current tab set with glosses and switches tab like the arrows", async () => {
  const f = fixture();
  await f.run();
  const [first] = control(f, "tab").options;
  assert.equal(control(f, "tab").options.length, 12);
  assert.deepEqual([first.label, first.description, first.emoji.name, first.default],
    ["Damage · DMG từng người, DPS, crit, back/front", "Tab 1/12", "⚔️", true]);
  await f.click(f.owner("tab", "tanked"));
  assert.equal(captures(f).at(-1)[2].tab, "tanked");
  assert.equal(control(f, "tab_label").label, "Tanked · 10/12");
  const count = captures(f).length;
  await f.click(f.owner("tab", "damage_category"));
  assert.equal(captures(f).length, count);
  assert.match(noticeText(f.events.at(-1)[1]), /không có trong/);
  await f.click(f.owner("player", "1-0"));
  assert.deepEqual(control(f, "tab").options.map(option => option.value),
    ["damage", "party_buffs", "party_buffs_all", "self_buffs", "self_buffs_all", "damage_category"]);
});

test("closed menus carry their facts: raid best parse, log figures, player icon and badges", async t => {
  withClassIcons(t, { Aeromancer: "<:aeromancer:111111111111111111>" });
  const logs = [
    { ...logEntry("new", "kazeros", Date.UTC(2026, 8, 24, 16, 40)), percentile: 0.9925, normalizedPercentile: 0.9,
      dps: 1.06e9, ndps: 385.7e6, duration: 447637 },
    { ...logEntry("old", "kazeros", Date.UTC(2026, 8, 24, 16, 31)), percentile: 0.6074, normalizedPercentile: 0.58,
      dps: 953e6, ndps: 345e6, duration: 288001, isDead: true },
    logEntry("serca", "serca", 80),
  ];
  const f = fixture({ logs });
  await f.run();
  const [kazeros, serca, refresh] = control(f, "raid").options;
  assert.deepEqual([kazeros.label, kazeros.emoji.name, kazeros.description, kazeros.default],
    ["kazeros · 2 log · tốt nhất 99%", "🌸", "Gần nhất 24/09 23:40", true]);
  assert.deepEqual([serca.label, serca.emoji.name], ["serca · 1 log · tốt nhất -", "⚪"]);
  assert.deepEqual([refresh.value, refresh.label, refresh.emoji.name], ["__refresh", "Làm mới", "🔄"]);
  const [open, older] = control(f, "log").options;
  assert.deepEqual([open.label, open.description, open.emoji.name, open.default],
    ["G2 Hard · 24/09 23:40 · 99% · 1.06B DPS · 386M nDPS · ⏱ 7:27", "Bracketed 99% · Normalized 90%", "🌸", true]);
  assert.equal(older.label, "G2 Hard · 24/09 23:31 · 60% · 953M DPS · 345M nDPS · ⏱ 4:48 · 💀");
  const players = control(f, "player").options;
  assert.deepEqual(players.map(option => option.label), ["Toàn đội · 8 người · 2 party", "Qiylyn · 1760 · 🌸 99 · Party 1",
    "Canameo · 1755 · 🟣 82 · 🟣 91 · Party 1", "Slayer #1 · 1746 · 🟣 80 · Party 2"]);
  assert.deepEqual(players.map(option => option.description), ["Bảng của cả đội", "Aeromancer · ⭐ đang tra", "Bard · support", "Slayer"]);
  assert.deepEqual(players[1].emoji, { animated: false, name: "aeromancer", id: "111111111111111111" });
  assert.equal(players[2].emoji, undefined);
});
