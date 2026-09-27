"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { fixture, captures, control } = require("./helpers/raid-log-fixture");
const { inspectPlayerPage, selectPlayer } = require("../bot/services/raid-log/detail");
const { RAID_LOG_TABS, RAID_LOG_PLAYER_TABS } = require("../bot/services/raid-log/tabs");
const { RaidLogError } = require("../bot/services/raid-log/errors");

test("an oversized second image or failed edit leaves the previous public card intact", async () => {
  const f = fixture({ transformCapture: result => {
    if (result.images) result.images[1].buffer = Buffer.alloc(12);
    return result;
  } });
  await f.run(); const before = JSON.stringify(f.payload);
  await f.click(f.owner("player", "1-0", { attachmentSizeLimit: 10 }));
  assert.equal(JSON.stringify(f.payload), before);
  assert.match(f.events.at(-1)[1].content, /giới hạn/);
  f.failEdit = true; await f.click(f.owner("player", "1-0"));
  assert.equal(JSON.stringify(f.payload), before);
  f.failEdit = false; await f.click(f.owner("player", "1-0"));
  assert.equal(f.payload.embeds.length, 2);
  f.verifyFailure = new RaidLogError("logs_private"); await f.click(f.owner("refresh"));
  assert.deepEqual(f.payload.attachments, []); assert.deepEqual(f.payload.embeds, []);
});

test("player selection replaces the tab set and publishes top/bottom images in order", async () => {
  for (const lang of ["vi", "en", "jp"]) {
    const f = fixture({ lang }); await f.run();
    await f.click(f.owner("player", "1-0"));
    assert.match(control(f, "tab_label").label, /^Skill Damage · 1\/6$/);
    assert.equal(captures(f).at(-1)[2].player.label, "1760 Qiylyn");
    assert.deepEqual(f.payload.files.map(file => file.name), ["top.png", "bottom.png"]);
    assert.deepEqual(f.payload.embeds.map(embed => embed.toJSON().image.url), ["attachment://top.png", "attachment://bottom.png"]);
    assert.doesNotMatch(JSON.stringify(f.payload), /raid-log\.controls/);
    for (let i = 1; i < Object.keys(RAID_LOG_PLAYER_TABS).length; i++) await f.click(f.owner("tab_next"));
    assert.equal(captures(f).at(-1)[2].tab, "damage_category");
    assert.equal(control(f, "tab_next").disabled, true);
    const count = captures(f).length;
    await f.click(f.owner("tab_next"));
    assert.equal(captures(f).length, count);
    await f.click(f.owner("tab_prev"));
    assert.equal(captures(f).at(-1)[2].tab, "self_buffs_all");
    await f.click(f.owner("player", "2-1"));
    assert.equal(captures(f).at(-1)[2].player.label, "1746 Slayer #1");
    assert.equal(control(f, "tab_label").label, "Skill Damage · 1/5");
  }
});

test("reset preserves the historical log and restores team Damage with Bracketed ON", async () => {
  const f = fixture(); await f.run();
  await f.click(f.owner("log", "old"));
  await f.click(f.owner("player", "1-0"));
  await f.click(f.owner("bracketed"));
  await f.click(f.owner("tab_next"));
  await f.click(f.owner("reset"));
  const [, url, options] = captures(f).at(-1);
  assert.equal(url, "https://lostark.bible/logs/old");
  assert.equal(options.player, null); assert.equal(options.tab, "damage"); assert.equal(options.bracketed, true);
  assert.equal(f.payload.embeds.length, 1); assert.equal(f.payload.files.length, 1);
  assert.deepEqual(f.payload.attachments, []);
  assert.equal(control(f, "log").options.find(option => option.default).value, "old");
  const count = captures(f).length;
  await f.click(f.owner("reset")); assert.equal(captures(f).length, count);
});

test("refresh reloads history and bypasses PNG cache without changing the current log/player/mode", async () => {
  const f = fixture(); await f.run(); await f.click(f.owner("log", "old"));
  await f.click(f.owner("player", "1-0")); await f.click(f.owner("bracketed"));
  f.events.length = 0;
  await f.click(f.owner("refresh"));
  assert.deepEqual(f.events.slice(0, 2), ["ack-update", "refresh"]);
  assert.ok(!f.events.includes("verify"));
  const [, url, options] = captures(f)[0];
  assert.equal(url, "https://lostark.bible/logs/old");
  assert.equal(options.refresh, true); assert.equal(options.player.id, "1-0"); assert.equal(options.bracketed, false);
  assert.equal(control(f, "log").options[0].value, "latest");
  assert.equal(control(f, "log").options.find(option => option.default).value, "old");
  await f.click(f.owner("raid", "serca"));
  assert.equal(captures(f).at(-1)[2].player, null);
  assert.equal(f.payload.files.length, 1);
});

test("team arrows cover every tab and reject disabled, forged and wrong-kind controls", async () => {
  const f = fixture(); await f.run();
  for (const tab of Object.keys(RAID_LOG_TABS).slice(1)) {
    await f.click(f.owner("tab_next"));
    assert.equal(captures(f).at(-1)[2].tab, tab);
  }
  const count = captures(f).length;
  for (const action of ["tab_next", "tab_label", "detail", "tab"]) await f.click(f.owner(action));
  await f.click(f.owner("player", "forged"));
  await f.click(f.owner("refresh", undefined, { isButton: () => false, isStringSelectMenu: () => true }));
  assert.equal(captures(f).length, count);
});

test("player selection dispatches on the validated cell and never follows a hover profile link", async () => {
  const actions = [];
  const cell = { locator: () => ({ first: () => ({ innerText: async () => "1755 Canameo" }) }),
    dispatchEvent: async event => actions.push(event), click: () => assert.fail("Pointer click could follow a profile tooltip") };
  const page = { getByRole: () => ({ click: async () => {}, waitFor: async () => {} }),
    locator: () => ({ filter: () => ({ nth: () => ({ locator: () => ({ nth: () => ({ locator: () => ({ nth: () => cell }) }) }) }) }) }) };
  assert.equal(await selectPlayer(page, { party: 1, row: 3, label: "1755 Canameo" }), true);
  assert.deepEqual(actions, ["click"]);
  assert.equal(await selectPlayer(page, { party: 1, row: 3, label: "Another player" }), false);
  assert.equal(actions.length, 1);
});

test("detail geometry covers the final chart with two overlapping images and rejects wrong/clipped content", () => {
  const dom = new JSDOM(`<div class="max-w-7xl"><h1>Raid</h1></div><main><section>Total DMG: 100
    <table><thead><tr><th><button aria-label="Return to Overview">Back</button></th></tr></thead>
    <tbody><tr><td></td><td><div class="truncate">1760 Qiylyn</div></td></tr></tbody></table></section>
    <section id="analysis">Damage Breakdown</section><section id="chart">Last chart</section></main>`, { runScripts: "outside-only" });
  const { window } = dom; const doc = window.document;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  Object.defineProperty(doc, "fonts", { value: { status: "loaded" } });
  const bounds = (selector, top, height) => {
    const el = doc.querySelector(selector);
    el.getBoundingClientRect = () => ({ left: 20, right: 1300, top, bottom: top + height, width: 1280, height });
    Object.defineProperty(el, "clientWidth", { value: 1280, configurable: true });
    Object.defineProperty(el, "scrollWidth", { value: 1280, configurable: true });
  };
  bounds(".max-w-7xl", 60, 200); bounds("main", 280, 3000); bounds("section", 280, 900);
  bounds("table", 320, 800); bounds("#analysis", 1200, 500); bounds("#chart", 1720, 1560);
  const inspect = player => window.eval(`(${inspectPlayerPage.toString()})(${JSON.stringify({ player, playerCount: 8, partyCount: 2 })})`);
  try {
    const result = inspect({ label: "1760 Qiylyn" });
    assert.equal(result.clips.length, 2);
    const [top, bottom] = result.clips;
    assert.equal(top.y, 60); assert.equal(bottom.y + bottom.height, 3280);
    assert.ok(top.y + top.height >= bottom.y); assert.ok(top.height < result.full.height);
    assert.equal(inspect({ label: "Wrong character" }).error, "incomplete");
    Object.defineProperty(doc.querySelector("table"), "scrollWidth", { value: 1400 });
    assert.equal(inspect({ label: "1760 Qiylyn" }).error, "incomplete");
  } finally { window.close(); }
});
