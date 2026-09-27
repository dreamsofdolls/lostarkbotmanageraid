"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, captures, control, noticeText, withClassIcons } = require("./helpers/raid-log-fixture");

const AERO = "<:aeromancer:111111111111111111>";
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 27, 12, 0);
const accounts = [
  { accountName: "Main roster", characters: [{ name: "Qiylyn", class: "Aeromancer", itemLevel: 1760 }] },
  { accountName: "Second roster", characters: [{ name: "Altchar", class: "Artist", itemLevel: 1700 }] },
];
const entry = (id, character, className, timestamp, extra = {}) => ({
  id, url: `https://lostark.bible/logs/${id}`, character, className, support: className === "Artist",
  raidKey: "kazeros", raidLabel: "Kazeros", gate: "G2", difficulty: "Hard", timestamp, duration: 447637, ...extra,
});
const RECENT = {
  entries: [
    entry("new", "Qiylyn", "Aeromancer", NOW - HOUR, { percentile: 0.9925, dps: 1.06e9, ndps: 385.7e6 }),
    entry("old", "Altchar", "Artist", NOW - 2 * HOUR,
      { contributionPercentile: 0.82, percentile: 0.91, buffs: [0.934, 0.963, 0.802, 0.328], rContribution: 0.511 }),
  ],
  private: ["Bori"], characters: 2, logs: 2, capped: false, timedOut: false,
};
const actionsOf = payload => payload.components.map(row => row.toJSON().components.map(c => c.custom_id.split(":").at(-1)));

async function openRecent(result = RECENT) {
  const f = fixture({ accounts });
  f.recentResult = result;
  await f.open();
  await f.click(f.owner("recent_open"));
  return f;
}

test("Log gần đây reads the caller's roster again, shows a loading card, then the newest fights", async t => {
  withClassIcons(t, { Aeromancer: AERO });
  const f = fixture({ accounts });
  f.recentResult = RECENT;
  await f.open();
  f.events.length = 0;
  await f.click(f.owner("recent_open"));
  assert.deepEqual(f.events.filter(event => event !== "edit"),
    ["ack-update", ["load", "author"], ["recent", "author", { refresh: false }]]);
  const [loading, done] = f.edits.slice(-2);
  const loadingCard = loading.embeds[0].toJSON();
  assert.equal(loadingCard.title, "🕘 Log gần đây · roster của cậu");
  assert.match(loadingCard.description, /\*\*2 nhân vật\*\*/);
  assert.deepEqual(loading.components, []);
  assert.deepEqual(done.embeds[0].toJSON().description.split("\n"), [
    `🌸 **Kazeros G2** Hard · ${AERO} Qiylyn · <t:${Math.floor((NOW - HOUR) / 1000)}:R>`,
    "-# 99% · 1.06B DPS · 386M nDPS · ⏱ 7:27",
    `🟣 **Kazeros G2** Hard · Altchar · <t:${Math.floor((NOW - 2 * HOUR) / 1000)}:R>`,
    "-# 82 · 91 · uptime 93·96·80·32 · 51.1% rCon · ⏱ 7:27",
    "",
    "-# 🔒 Chưa bật Public Log: Bori · 2 log mới nhất từ 2 nhân vật",
  ]);
  assert.deepEqual(actionsOf(done), [["picker", "recent_refresh"], ["recent"]]);
  const options = done.components[1].toJSON().components[0].options;
  assert.deepEqual(options.map(option => [option.value, option.label, option.emoji.name]),
    [["0", "Kazeros G2 Hard · Qiylyn · 99", "🌸"], ["1", "Kazeros G2 Hard · Altchar · 82 · 91", "🟣"]]);
  assert.equal(options[0].description, "99% · 1.06B DPS · 386M nDPS · ⏱ 7:27 · 27/09 18:00");
});

test("Refresh asks Bible again and the back button returns to the same picker", async () => {
  const f = await openRecent();
  await f.click(f.owner("recent_refresh"));
  assert.deepEqual(f.events.filter(event => event[0] === "recent").map(event => event[2]), [{ refresh: false }, { refresh: true }]);
  await f.click(f.owner("picker"));
  assert.equal(f.payload.embeds[0].toJSON().title, "📜 Raid log");
  assert.deepEqual(actionsOf(f.payload), [["search", "recent_open"], ["character"]]);
  assert.deepEqual(control(f, "character").options.map(option => option.label), ["Qiylyn", "Altchar"]);
});

test("choosing a fight opens that exact log for its character after checking the roster again", async () => {
  const f = await openRecent();
  f.events.length = 0;
  await f.click(f.owner("recent", "1"));
  assert.deepEqual(f.events.filter(event => Array.isArray(event) && ["load", "open"].includes(event[0])),
    [["load", "author"], ["open", "Altchar"]]);
  assert.deepEqual(captures(f).at(-1).slice(1), ["https://lostark.bible/logs/old",
    { view: "full", tab: "damage", bracketed: true, player: null, useCache: true, refresh: false }]);
  assert.equal(control(f, "log").options.find(option => option.default).value, "old");
});

test("a fight whose log is gone or whose character left the roster is refused without a capture", async () => {
  const f = await openRecent({ ...RECENT, entries: [...RECENT.entries, entry("gone", "Qiylyn", "Aeromancer", NOW - 3 * HOUR)] });
  await f.click(f.owner("recent", "2"));
  assert.match(noticeText(f.events.at(-1)[1]), /không có trong/);
  f.userDoc = { accounts: [accounts[0]] };
  await f.click(f.owner("recent", "1"));
  assert.match(noticeText(f.events.at(-1)[1]), /không còn trong roster/);
  assert.equal(captures(f).length, 0);
});

test("when Bible fails for the whole roster the previous card comes back with a notice", async () => {
  const limited = Object.assign(new Error("HTTP 429"), { status: 429 });
  const f = fixture({ accounts });
  f.recentResult = limited;
  await f.open();
  await f.click(f.owner("recent_open"));
  const [event, notice] = f.events.at(-1);
  assert.equal(event, "followUp");
  assert.match(noticeText(notice), /Bible đang giới hạn/);
  assert.equal(f.payload.embeds[0].toJSON().title, "📜 Raid log");
  assert.deepEqual(actionsOf(f.payload), [["search", "recent_open"], ["character"]]);
  f.recentResult = RECENT;
  await f.click(f.owner("recent_open"));
  f.recentResult = limited;
  await f.click(f.owner("recent_refresh"));
  assert.match(f.payload.embeds[0].toJSON().title, /^🕘/);
  assert.deepEqual(actionsOf(f.payload), [["picker", "recent_refresh"], ["recent"]]);
});

test("a fight without a difficulty keeps single spaces on the card and in the menu", async () => {
  const f = await openRecent({ ...RECENT, entries: [entry("solo", "Qiylyn", "Aeromancer", NOW - HOUR, { difficulty: "", percentile: 0.5 })] });
  assert.match(f.payload.embeds[0].toJSON().description, /^🔵 \*\*Kazeros G2\*\* · Qiylyn · <t:/);
  assert.equal(f.payload.components[1].toJSON().components[0].options[0].label, "Kazeros G2 · Qiylyn · 50");
});

test("a roster with no public logs gets the empty card with the private list and no menu", async () => {
  const f = await openRecent({ entries: [], private: ["Altchar", "Qiylyn"], characters: 0, logs: 0, capped: false, timedOut: false });
  assert.equal(f.payload.embeds[0].toJSON().description,
    "Roster của cậu chưa có log public nào.\n\n-# 🔒 Chưa bật Public Log: Altchar, Qiylyn");
  assert.deepEqual(actionsOf(f.payload), [["picker", "recent_refresh"]]);
});

test("the footer cuts the private list at ten and notes the character cap and a slow Bible", async () => {
  const names = Array.from({ length: 12 }, (_, i) => `Alt${i}`);
  const f = await openRecent({ ...RECENT, private: names, capped: true, timedOut: true });
  assert.equal(f.payload.embeds[0].toJSON().description.split("\n").at(-1),
    `-# 🔒 Chưa bật Public Log: ${names.slice(0, 10).join(", ")} +2 · 2 log mới nhất từ 2 nhân vật`
    + " · chỉ 24 nhân vật iLvl cao nhất · Bible trả chậm, đây là phần đã gom được");
});

test("only the caller can use the recent card, and each stage accepts only its own actions", async () => {
  const f = fixture({ accounts });
  f.recentResult = RECENT;
  await f.open();
  await f.click(f.component("recent_open"));
  assert.match(noticeText(f.events.at(-1)[1]), /không phải của cậu/);
  await f.click(f.owner("recent", "0"));
  assert.match(noticeText(f.events.at(-1)[1]), /không có trong/);
  await f.click(f.owner("recent_open"));
  for (const [action, value] of [["recent_refresh"], ["recent", "0"], ["picker"]]) {
    await f.click(f.component(action, value));
    assert.match(noticeText(f.events.at(-1)[1]), /không phải của cậu/);
  }
  for (const [action, value] of [["search"], ["character", "0"], ["tab_next"], ["raid", "__refresh"]]) {
    await f.click(f.owner(action, value));
    assert.match(noticeText(f.events.at(-1)[1]), /không có trong/);
  }
  assert.equal(f.events.filter(event => event[0] === "recent").length, 1);
  await f.click(f.owner("recent", "0"));
  assert.equal(captures(f).length, 1);
  for (const [action, value] of [["recent_refresh"], ["picker"], ["recent", "0"]]) {
    await f.click(f.owner(action, value));
    assert.match(noticeText(f.events.at(-1)[1]), /không có trong/);
  }
});
