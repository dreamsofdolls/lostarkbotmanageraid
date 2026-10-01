"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, logEntry, withClassIcons } = require("./helpers/raid-log-fixture");

const AERO = "<:aeromancer:111111111111111111>";
const BARD = "<:bard:222222222222222222>";
const G2 = Date.UTC(2026, 8, 24, 16, 40);
const G1 = Date.UTC(2026, 8, 24, 16, 31);
const KAZEROS = [
  { ...logEntry("new", "kazeros", G2), percentile: 0.9925, normalizedPercentile: 0.9, dps: 1.06e9, ndps: 385.7e6, duration: 447637 },
  { ...logEntry("old", "kazeros", G1), gate: "G1", percentile: 0.6074, normalizedPercentile: 0.58, dps: 953e6, ndps: 345e6,
    duration: 288001, isDead: true },
  logEntry("serca", "serca", 80),
];
const card = f => f.payload.embeds[0].toJSON();

test("the card names each MVP and score with a class icon, then the raid's latest logs", async t => {
  withClassIcons(t, { Aeromancer: AERO, Bard: BARD });
  const f = fixture({ logs: KAZEROS });
  await f.run();
  const embed = card(f);
  assert.equal(embed.title, "📜 kazeros · nhật ký của Qiylyn");
  assert.equal(embed.url, "https://lostark.bible/logs/new");
  assert.equal(embed.color, 0xe268a8);
  assert.equal(embed.description, undefined);
  assert.equal(embed.footer, undefined);
  assert.deepEqual(embed.fields.map(field => [field.name, field.value]), [
    ["👑 MVP DMG", `${AERO} **Qiylyn**\n\`24.6% D%\``],
    ["📈 Score DPS", `${AERO} **Qiylyn**\n\`🌸 99\`\n\`386M nDPS\``],
    ["🎯 MVP Counter", `${AERO} **Qiylyn**\n\`3 counter\``],
    ["✨ MVP Sup", `${BARD} **Canameo**\n\`31.8% bD%\``],
    ["🤝 Sup Perform",`${BARD} **Canameo**\n\`🟣 82\`\n\`51.1% rCon\``],
    ["⏱️ Sup uptime", `${BARD} **Canameo**\n\`🟣 91\``],
    ["📜 2 log gần nhất", [
      "▶ 🌸 G2 · 24/09 23:40 · **99%** · 1.06B DPS · 386M nDPS · ⏱ 7:27",
      "-# 🔵 G1 · 24/09 23:31 · **60%** · 953M DPS · 345M nDPS · ⏱ 4:48 · 💀",
    ].join("\n")],
  ]);
  assert.ok(embed.fields.slice(0, 6).every(field => field.inline));
  assert.equal(embed.fields[6].inline, undefined);
  assert.equal(embed.image.url, "attachment://capture.png");
});

test("Normalized changes the dealer score, the side colour and each dealer percent", async () => {
  const f = fixture({ logs: KAZEROS });
  await f.run();
  await f.click(f.owner("bracketed"));
  const embed = card(f);
  assert.equal(embed.fields[1].value, "**Qiylyn**\n`🟠 98`\n`386M nDPS`");
  assert.equal(embed.color, 0xa335ee);
  assert.match(embed.fields[6].value, /^▶ 🟣 G2 · 24\/09 23:40 · \*\*90%\*\*/);
  assert.match(embed.fields[6].value, /\n-# 🔵 G1 · 24\/09 23:31 · \*\*58%\*\*/);
});

test("a log without supports or counters says so instead of naming someone", async () => {
  const f = fixture({ logs: KAZEROS, transformCapture: result => ({ ...result,
    players: result.players.filter(player => player.className !== "Bard").map(player => ({ ...player, counters: 0 })) }) });
  await f.run();
  const values = card(f).fields.map(field => field.value);
  assert.equal(values[2], "Không ai counter\n`0`");
  assert.deepEqual(values.slice(3, 6), Array(3).fill("Không có support\n`-`"));
});

test("a log whose counters Bible did not give names the STAG leader with - rather than claiming nobody countered", async () => {
  const f = fixture({ logs: KAZEROS, transformCapture: result => ({ ...result,
    players: result.players.map(player => ({ ...player, counters: null })) }) });
  await f.run();
  assert.equal(card(f).fields[2].value, "**Slayer #1**\n`-`");
});

test("a support whose figures Bible did not give keeps the name and shows -", async () => {
  const f = fixture({ logs: KAZEROS, transformCapture: result => ({ ...result,
    players: result.players.map(player => ({ ...player, buffedShare: null })) }) });
  await f.run();
  assert.equal(card(f).fields[3].value, "**Canameo**\n`-`");
});

test("a looked-up support is judged by rContribution, and a missing percentile shows - rather than 0%", async () => {
  const logs = [
    { ...logEntry("new", "kazeros", G2), contributionPercentile: 0.9737, percentile: null, rContribution: 0.5259, duration: 447637 },
    { ...logEntry("old", "kazeros", G1), gate: "G1", contributionPercentile: null, percentile: 0.7936, rContribution: null, duration: 288001 },
  ];
  const f = fixture({ logs, profile: { name: "Canameo", className: "Bard" } });
  await f.run();
  const embed = card(f);
  assert.equal(embed.color, 0xff8000);
  assert.equal(embed.fields[6].value, [
    "▶ 🟠 G2 · 24/09 23:40 · **97%** · - uptime · 52.6% rCon · ⏱ 7:27",
    "-# ⚪ G1 · 24/09 23:31 · **-** · 79% uptime · - rCon · ⏱ 4:48",
  ].join("\n"));
  assert.doesNotMatch(embed.fields[6].value, /\b0%/);
});

test("the history shows the raid's newest five and keeps an older open log on the last line", async () => {
  const logs = Array.from({ length: 7 }, (_, i) => ({ ...logEntry(`l${i}`, "kazeros", G2 - i * 3_600_000), percentile: 0.5 }));
  const f = fixture({ logs });
  await f.run();
  await f.click(f.owner("log", "l6"));
  const history = card(f).fields[6];
  const lines = history.value.split("\n");
  assert.equal(history.name, "📜 5 log gần nhất");
  assert.equal(lines.length, 5);
  assert.match(lines[4], /^▶ 🔵 G2 · 24\/09 17:40 /);
  assert.ok(lines.slice(0, 4).every(line => line.startsWith("-# ")));
});

test("a player view links Bible's profile page and puts the lower image in a bare second embed", async () => {
  const f = fixture({ logs: KAZEROS });
  await f.run();
  await f.click(f.owner("player", "1-0"));
  const [first, second] = f.payload.embeds.map(embed => embed.toJSON());
  assert.equal(first.description, "-# 🔗 [Character Profile](https://lostark.bible/character/NA/Qiylyn)");
  assert.equal(first.image.url, "attachment://top.png");
  assert.deepEqual(second, { color: first.color, image: { url: "attachment://bottom.png" } });
});

test("the card has no raw locale keys in any language", async () => {
  for (const lang of ["vi", "en", "jp"]) {
    const f = fixture({ lang, logs: KAZEROS });
    await f.run();
    assert.doesNotMatch(JSON.stringify(f.payload.embeds), /raid-log\./);
  }
});
