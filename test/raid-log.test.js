"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { JSDOM } = require("jsdom");
const { EmbedBuilder, AttachmentBuilder, MessageFlags } = require("discord.js");
const { createRaidLogCapture, isAllowedRequest, inspectDamagePage } = require("../bot/services/raid-log/capture");
const { parsePublicLogUrl } = require("../bot/services/raid-log/source");
const { RaidLogError } = require("../bot/services/raid-log/errors");
const { createRaidLogCommand, buildSummaryFields } = require("../bot/handlers/raid/log");
const { createRaidLogCommandDefinition } = require("../bot/handlers/commands/command-definitions/public-log");
const { BibleRequestLimiter } = require("../bot/services/auto-manage/bible/rate-limit");
const URL = "https://lostark.bible/logs/S9NbBTM";

test("public URLs are canonicalized and unsafe/non-log destinations are rejected", () => {
  assert.deepEqual(parsePublicLogUrl(` ${URL}/ `), { id: "S9NbBTM", url: URL });
  for (const input of [null, "", "http://lostark.bible/logs/a", "https://evil.test/logs/a",
    "https://lostark.bible.evil.test/logs/a", "https://lostark.bible@evil.test/logs/a",
    "https://user:pass@lostark.bible/logs/a", "https://lostark.bible:8443/logs/a",
    "https://lostark.bible/character/NA/a", `${URL}?url=http://127.0.0.1`, `${URL}#damage`,
    "https://lostark.bible/logs/../admin", "https://lostark.bible/logs/%2e%2e",
    "https://lostark.bible/logs/" + "a".repeat(65)]) {
    assert.throws(() => parsePublicLogUrl(input), { code: "invalid_url" });
  }
});

test("browser requests cannot leave Bible or navigate away from the public log", () => {
  assert.equal(isAllowedRequest(URL, true, URL), true);
  assert.equal(isAllowedRequest(`${URL}/`, true, URL), true);
  assert.equal(isAllowedRequest("https://lostark.bible/assets/class.png", false, URL), true);
  assert.equal(isAllowedRequest("https://cdn.ags.lol/icon/item.png", false, URL, "image"), true);
  assert.equal(isAllowedRequest("https://cdn.ags.lol/script.js", false, URL, "script"), false);
  assert.equal(isAllowedRequest("https://cdn.ags.lol/icon/item.png", true, URL, "image"), false);
  for (const address of ["http://127.0.0.1/", "http://169.254.169.254/", "file:///etc/passwd",
    "https://other.test/a", "https://u:p@lostark.bible/assets/a", "invalid"]) {
    assert.equal(isAllowedRequest(address, false, URL), false);
  }
  assert.equal(isAllowedRequest("https://lostark.bible/login", true, URL), false);
});

test("command opens a guild-only experiment without slash options", () => {
  const data = createRaidLogCommandDefinition().toJSON();
  assert.equal(data.name, "raid-log");
  assert.equal(data.dm_permission, false);
  assert.match(data.description, /TEST/);
  assert.deepEqual(data.options, []);
});

function fakeBrowser({ status = 200, screenshotError, holdNavigation = false, onScreenshot, onNavigate, closeError } = {}) {
  let rejectNavigation;
  let normalized = false;
  const state = { closed: 0, launches: 0, navigations: 0, routes: [] };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {},
    setViewportSize: async () => {},
    keyboard: { press: async () => {} },
    goto: async () => {
      state.navigations++;
      onNavigate?.();
      return holdNavigation ? new Promise((resolve, reject) => { rejectNavigation = reject; })
        : ({ ok: () => status === 200, status: () => status, headers: () => ({ "retry-after": "60" }) });
    },
    getByRole: (role, options) => ({
      click: async () => { if (!["Settings", "Given"].includes(options.name)) state.tab = options.name; },
      isChecked: async () => normalized, count: async () => 0,
      filter: () => ({ locator: () => ({ isChecked: async () => true, click: async () => {} }) }),
    }),
    locator: () => ({ filter: () => ({ waitFor: async () => {}, click: async () => { normalized = !normalized; } }) }),
    waitForFunction: async () => {},
    evaluate: async fn => fn === inspectDamagePage ? {
      title: "Kazeros G2", header: "Hard\nKazeros\n09:15", playerCount: 8, partyCount: 2,
      team: { x: 0, y: 0, width: 1280, height: 400 }, full: { x: 0, y: 0, width: 1280, height: 800 },
      players: [],
    } : 96,
    mouse: { move: async () => {} },
    screenshot: async options => {
      state.clip = options.clip;
      state.scale = options.scale;
      state.normalized = normalized;
      await onScreenshot?.(page);
      if (screenshotError) throw screenshotError;
      return Buffer.from("png");
    },
  });
  const browser = Object.assign(new EventEmitter(), {
    newContext: async options => {
      state.context = options;
      return { route: async (pattern, fn) => state.routes.push(fn), newPage: async () => page };
    },
    close: async () => {
      state.closed++;
      rejectNavigation?.(new Error("Browser closed"));
      browser.emit("disconnected");
      if (closeError) throw closeError;
    },
  });
  return { state, page, log: {}, launchBrowser: async () => { state.launches++; return browser; } };
}

test("warm capture switches tabs/modes without navigation, caches variants and resets on another log", async () => {
  const fake = fakeBrowser();
  const capture = createRaidLogCapture({ ...fake, idleMs: 60_000 });
  try {
    const initial = await capture(URL, { useCache: true });
    assert.equal(initial.filename, "raid-log-S9NbBTM-full-damage-bracketed.png");
    assert.equal(fake.state.clip.height, 800);
    assert.equal(fake.state.normalized, false);
    assert.equal(fake.state.closed, 0);
    await capture(URL, { tab: "self_buffs", bracketed: false, useCache: true });
    assert.equal(fake.state.tab, "Self Buffs");
    assert.equal(fake.state.normalized, true);
    assert.equal(fake.state.launches, 1);
    assert.equal(fake.state.navigations, 1);
    const cached = await capture(URL, { useCache: true });
    assert.equal(cached.cached, true);
    await capture("https://lostark.bible/logs/other", { tab: "tanked", bracketed: true });
    assert.equal(fake.state.navigations, 2);
    assert.equal(fake.state.tab, "Tanked");
    assert.equal(fake.state.normalized, false);
    await assert.rejects(capture(URL, { tab: "Settings" }), { code: "invalid_selection" });
    await assert.rejects(capture(URL, { bracketed: "true" }), { code: "invalid_selection" });
  } finally { await capture.close(); }
  assert.equal(fake.state.closed, 1);
});

test("warm browser closes when idle and a renderer that crashes while idle is replaced", async t => {
  const failed = fakeBrowser();
  const healthy = fakeBrowser();
  let launches = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capture = createRaidLogCapture({ idleMs: 45_000, log: {}, launchBrowser: () => {
    return ++launches === 1 ? failed.launchBrowser() : healthy.launchBrowser();
  } });
  try {
    await capture(URL);
    failed.page.emit("crash");
    await capture(URL, { tab: "shields" });
    assert.equal(launches, 2);
    assert.equal(failed.state.closed, 1);
    t.mock.timers.tick(45_000);
    assert.equal(healthy.state.closed, 1);
  } finally { await capture.close(); }
});

test("refresh forces navigation and invalidates other cached variants for that log", async () => {
  const fake = fakeBrowser(); const capture = createRaidLogCapture({ ...fake, idleMs: 60_000 });
  try {
    await capture(URL, { useCache: true });
    await capture(URL, { tab: "tanked", useCache: true });
    assert.equal((await capture(URL, { useCache: true })).cached, true);
    assert.equal((await capture(URL, { useCache: true, refresh: true })).cached, undefined);
    assert.equal(fake.state.navigations, 2);
    assert.equal((await capture(URL, { tab: "tanked", useCache: true })).cached, undefined);
    assert.equal(fake.state.navigations, 2);
  } finally { await capture.close(); }
});

test("capture returns selected region and closes the browser after success or screenshot failure", async () => {
  for (const view of ["team", "full"]) {
    const fake = fakeBrowser();
    const result = await createRaidLogCapture(fake)(URL, { view });
    assert.equal(result.filename, `raid-log-S9NbBTM-${view}-damage-bracketed.png`);
    assert.equal(fake.state.clip.height, view === "team" ? 400 : 800);
    assert.equal(fake.state.closed, 1);
    assert.equal(fake.state.context.serviceWorkers, "block");
    assert.equal(fake.state.context.deviceScaleFactor, 1);
    assert.equal(fake.state.scale, "css");
  }
  const fake = fakeBrowser({ screenshotError: new Error("Screenshot failed") });
  await assert.rejects(createRaidLogCapture(fake)(URL), /Screenshot failed/);
  assert.equal(fake.state.closed, 1);
});

test("a crashed renderer is closed before one retry, holding the busy slot throughout recovery", async () => {
  const warnings = [];
  let capture;
  const failed = fakeBrowser({
    onScreenshot: async page => { page.emit("crash"); throw new Error("page.screenshot: Target crashed"); },
    closeError: new Error("Already disconnected"),
  });
  const healthy = fakeBrowser();
  let launches = 0;
  capture = createRaidLogCapture({
    log: { warn: message => warnings.push(message) },
    launchBrowser: async () => {
      if (++launches === 1) return failed.launchBrowser();
      assert.equal(failed.state.closed, 1);
      await assert.rejects(capture(URL), { code: "busy" });
      return healthy.launchBrowser();
    },
  });
  assert.equal((await capture(URL)).playerCount, 8);
  assert.equal(launches, 2);
  assert.equal(healthy.state.closed, 1);
  const diagnostic = warnings.find(message => message.startsWith("[raid-log] browser_crashed "));
  assert.match(diagnostic, /"stage":"screenshot"/);
  assert.match(diagnostic, /"memoryBefore":/);
  assert.match(diagnostic, /"memoryAfter":/);
});

test("repeated crashes stop after two attempts and release the slot for the next call", async () => {
  const fake = fakeBrowser({ screenshotError: new Error("page.screenshot: Target crashed") });
  const capture = createRaidLogCapture(fake);
  await assert.rejects(capture(URL), { code: "browser_crashed" });
  assert.equal(fake.state.launches, 2);
  assert.equal(fake.state.closed, 2);
  await assert.rejects(capture(URL), { code: "browser_crashed" });
  assert.equal(fake.state.launches, 4);
  assert.equal(fake.state.closed, 4);
});

test("crash recovery respects Bible backoff opened during the first attempt", async () => {
  const { createBibleHttpError } = require("../bot/services/auto-manage/bible/rate-limit");
  const bibleLimiter = new BibleRequestLimiter(2, { log: {} });
  const fake = fakeBrowser({ onScreenshot: async () => {
    await assert.rejects(bibleLimiter.run(() => { throw createBibleHttpError("HTTP 429", { status: 429 }); }));
    throw new Error("page.screenshot: Target crashed");
  } });
  await assert.rejects(createRaidLogCapture({ ...fake, bibleLimiter })(URL), { status: 429, isBibleBackoff: true });
  assert.equal(fake.state.launches, 1);
  assert.equal(fake.state.closed, 1);
});

test("recovery uses the remaining budget and never launches after the original deadline", async t => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  for (const elapsed of [55_000, 60_001]) {
    now = 0;
    const failed = fakeBrowser({ onScreenshot: async () => {
      now = elapsed;
      throw new Error("Target crashed");
    } });
    const healthy = fakeBrowser();
    const timeouts = [];
    const capture = createRaidLogCapture({ log: {}, launchBrowser: options => {
      timeouts.push(options.timeout);
      return timeouts.length === 1 ? failed.launchBrowser() : healthy.launchBrowser();
    } });
    if (elapsed < 60_000) {
      await capture(URL);
      assert.deepEqual(timeouts, [15_000, 5_000]);
      assert.equal(healthy.state.closed, 1);
    } else {
      await assert.rejects(capture(URL), { code: "timeout" });
      assert.deepEqual(timeouts, [15_000]);
    }
    assert.equal(failed.state.closed, 1);
  }
});

test("capture rejects overlap before launching and releases its slot after timeout", async t => {
  // Advance only after navigation starts; real 25ms deadlines race disk IO
  // when the full suite is running and can expire before a browser launches.
  t.mock.method(Date, "now", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered;
  const fake = fakeBrowser({ holdNavigation: true, onNavigate: () => entered() });
  const capture = createRaidLogCapture({ ...fake, timeoutMs: 25 });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const navigating = new Promise(resolve => { entered = resolve; });
    const pending = capture(URL);
    await assert.rejects(capture(URL), { code: "busy" });
    await navigating;
    t.mock.timers.tick(25);
    await assert.rejects(pending, { code: "timeout" });
    assert.equal(fake.state.closed, attempt);
  }
});

test("HTTP 429 opens the shared Bible backoff and missing logs close their browser", async () => {
  const fake = fakeBrowser({ status: 429 });
  const bibleLimiter = new BibleRequestLimiter(2, { log: {} });
  const capture = createRaidLogCapture({ ...fake, bibleLimiter });
  await assert.rejects(capture(URL), { status: 429, retryAfterMs: 60_000 });
  await assert.rejects(capture(URL), { status: 429, isBibleBackoff: true });
  assert.equal(fake.state.launches, 1);
  assert.equal(fake.state.closed, 1);
  const missing = fakeBrowser({ status: 404 });
  await assert.rejects(createRaidLogCapture(missing)(URL), { code: "unavailable" });
  assert.equal(missing.state.closed, 1);
});

test("invalid input never launches a browser and unavailable browser has a typed error", async () => {
  const fake = fakeBrowser();
  const capture = createRaidLogCapture(fake);
  await assert.rejects(capture("https://localhost/"), { code: "invalid_url" });
  await assert.rejects(capture(URL, { view: "unknown" }), { code: "invalid_view" });
  assert.equal(fake.state.launches, 0);
  await assert.rejects(createRaidLogCapture({ launchBrowser: async () => { throw new Error("Missing executable"); } })(URL),
    { code: "browser_unavailable" });
});

function damageFixture(players = 8) {
  const dom = new JSDOM('<title>Kazeros G2 | lostark.bible</title><div class="max-w-7xl"><h1>Kazeros G2</h1></div><section>Total DMG: 99b</section>', { runScripts: "outside-only" });
  const { window } = dom;
  const { document } = window;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  Object.defineProperty(document, "fonts", { value: { status: "loaded" } });
  function bounds(element, left, top, width, height) {
    element.getBoundingClientRect = () => ({ left, top, right: left + width, bottom: top + height, width, height });
    Object.defineProperty(element, "clientWidth", { value: width, configurable: true });
    Object.defineProperty(element, "scrollWidth", { value: width, configurable: true });
  }
  const card = document.querySelector("section");
  bounds(document.querySelector(".max-w-7xl"), 160, 60, 1280, 200);
  bounds(card, 176, 292, 1248, 600);
  for (let i = 0; i < players / 4; i++) {
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>Party ${i + 1}</th></tr></thead><tbody>${"<tr><td>1</td><td>Wardancer #3</td></tr>".repeat(4)}</tbody>`;
    card.appendChild(table);
    bounds(table, 184, 340 + i * 200, 1232, 180);
    table.querySelectorAll("tbody tr").forEach((row, j) => bounds(row, 184, 360 + i * 200 + j * 35, 1232, 35));
  }
  const summary = document.createElement("table");
  card.appendChild(summary);
  bounds(summary, 184, 340 + players / 4 * 200, 1232, 100);
  return { dom, document, inspect: () => window.eval(`(${inspectDamagePage.toString()})()`) };
}

test("real DOM inspection includes every party row for 4/8 players and rejects clipping or missing assets", () => {
  for (const players of [4, 8]) {
    const fixture = damageFixture(players);
    try {
      const result = fixture.inspect();
      assert.equal(result.playerCount, players);
      assert.equal(result.partyCount, players / 4);
      assert.equal(result.title, "Kazeros G2");
      assert.ok(result.full.height > result.team.height);
      assert.equal(result.team.y + result.team.height, 340 + (players / 4 - 1) * 200 + 180 + 4);
      const table = fixture.document.querySelector("table");
      Object.defineProperty(table, "scrollWidth", { value: 1400, configurable: true });
      assert.equal(fixture.inspect().error, "incomplete");
      Object.defineProperty(table, "scrollWidth", { value: 1232, configurable: true });
      fixture.document.querySelector("section").appendChild(fixture.document.createElement("img"));
      assert.equal(fixture.inspect().error, "incomplete");
    } finally { fixture.dom.window.close(); }
  }
});

function handlerFixture({ character = "Saturnxd", error, lookupError, lang = "vi", attachmentSizeLimit } = {}) {
  const calls = [];
  let payload;
  let modal;
  const interaction = {
    user: { id: "caller" }, guildId: "guild", channelId: "channel", attachmentSizeLimit,
    deferReply: async options => calls.push(["defer", options]),
    editReply: async next => { payload = next; calls.push([next.files ? "edit" : "picker", next]); return { id: "message" }; },
  };
  const handler = createRaidLogCommand({
    EmbedBuilder, AttachmentBuilder, MessageFlags, UI: { colors: { progress: 0xfee75c } }, log: {},
    loadCaller: async () => { calls.push(["roster"]); return null; },
    resolveStoredLanguage: async () => { calls.push(["language"]); return lang; },
    logCatalog: { open: async name => {
      calls.push(["lookup", name]);
      if (lookupError) throw lookupError;
      return { profile: { name: "Saturnxd" }, logs: [{ id: "S9NbBTM", url: URL, character: "Saturnxd", raidKey: "kazeros", raidLabel: "Kazeros" }] };
    } },
    captureRaidLog: async (url, options) => {
      calls.push(["capture", url, options]);
      if (error) throw error;
      return { url: URL, title: "Kazeros G2", header: "Hard\nKazeros G2\n09:15",
        summary: "Duration:\n7:27\n+0:39\n·\nTotal DMG:\n1,928,393,107,867\n·\nTotal DPS:\n4,314,078,107\nDamage",
        playerCount: 8, partyCount: 2, filename: "log.png", buffer: Buffer.from("png") };
    },
  });
  return { calls, interaction, run: async () => {
    await handler.handleRaidLogCommand(interaction);
    const base = { ...interaction, message: { id: "message" },
      reply: async reply => calls.push(["error", reply]), followUp: async reply => calls.push(["error", reply]) };
    await handler.handleRaidLogComponent({ ...base,
      customId: payload.components[0].toJSON().components[0].custom_id, isButton: () => true,
      showModal: async value => { modal = value.toJSON(); },
    });
    const submit = { ...base, customId: modal.custom_id, isModalSubmit: () => true,
      fields: { getTextInputValue: () => character },
      deferUpdate: async () => { calls.push(["ack-update"]); submit.deferred = true; },
    };
    await handler.handleRaidLogComponent(submit);
  } };
}

test("handler acknowledges first, attaches a public image with source link in all locales", async () => {
  for (const lang of ["vi", "en", "jp"]) {
    const fixture = handlerFixture({ lang });
    await fixture.run();
    assert.deepEqual(fixture.calls.map(call => call[0]), ["defer", "roster", "language", "picker", "ack-update", "lookup", "capture", "edit"]);
    assert.deepEqual(fixture.calls[0][1], {});
    assert.equal(fixture.calls[6][2].view, "full");
    assert.equal(fixture.calls[6][2].bracketed, true);
    const payload = fixture.calls.at(-1)[1];
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.url, URL);
    assert.match(embed.title, /TEST/);
    assert.match(embed.footer.text, /TEST/);
    assert.deepEqual(embed.fields.slice(1).map(field => field.value), ["7:27 +0:39", "1,928,393,107,867", "4,314,078,107"]);
    assert.ok(embed.fields.slice(1).every(field => field.inline));
    assert.equal(embed.image.url, "attachment://log.png");
    assert.equal(payload.files[0].name, "log.png");
    assert.match(embed.description, /8/);
    assert.doesNotMatch(JSON.stringify(embed), /raid-log\./);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
  }
});

test("TEST summary preserves source duration and numbers without inventing missing values", () => {
  assert.deepEqual(buildSummaryFields(undefined, "vi"), []);
  assert.deepEqual(buildSummaryFields("Duration:\n7:04\n·\nTotal DMG:\n1,539,242,432,317", "vi").map(field => field.value),
    ["7:04", "1,539,242,432,317"]);
});

test("handler keeps invalid names private, avoids capture and returns localized errors without attachments", async () => {
  const invalid = handlerFixture({ character: "https://localhost/" });
  await invalid.run();
  assert.equal(invalid.calls.at(-1)[1].flags, MessageFlags.Ephemeral);
  assert.ok(!invalid.calls.some(call => call[0] === "capture"));
  for (const error of [new RaidLogError("busy"), new RaidLogError("timeout"), new RaidLogError("browser_crashed"),
    Object.assign(new Error("HTTP 429"), { status: 429 }), new Error("SECRET INTERNAL PATH")]) {
    const fixture = handlerFixture({ error });
    await fixture.run();
    const payload = fixture.calls.at(-1)[1];
    assert.ok(payload.content);
    assert.doesNotMatch(payload.content, /raid-log\.|SECRET INTERNAL PATH/);
    assert.equal(payload.flags, MessageFlags.Ephemeral);
    assert.equal(payload.files, undefined);
  }
  const small = handlerFixture({ attachmentSizeLimit: 1 });
  await small.run();
  assert.match(small.calls.at(-1)[1].content, /giới hạn đính kèm/);
});

test("character lookup defaults to latest log, acknowledges first and labels the selected character", async () => {
  for (const lang of ["vi", "en", "jp"]) {
    const fixture = handlerFixture({ character: "saturnxd", lang });
    await fixture.run();
    assert.deepEqual(fixture.calls.map(call => call[0]), ["defer", "roster", "language", "picker", "ack-update", "lookup", "capture", "edit"]);
    assert.equal(fixture.calls[5][1], "saturnxd");
    assert.equal(fixture.calls[6][1], URL);
    assert.equal(fixture.calls[6][2].view, "full");
    const embed = fixture.calls.at(-1)[1].embeds[0].toJSON();
    assert.match(embed.description, /Saturnxd/);
    assert.match(embed.description, /NA/);
    assert.doesNotMatch(embed.description, /raid-log\./);
  }
});

test("missing/invalid names reject privately before lookup and private characters never reach capture", async () => {
  for (const character of [null, "", " ", "Not A Name"]) {
    const fixture = handlerFixture({ character });
    await fixture.run();
    assert.equal(fixture.calls.at(-1)[1].flags, MessageFlags.Ephemeral);
    assert.deepEqual(fixture.calls.map(call => call[0]), ["defer", "roster", "language", "picker", "ack-update", "error"]);
    assert.doesNotMatch(fixture.calls.at(-1)[1].content, /`(?:url|view):/);
  }
  for (const code of ["character_not_found", "character_mismatch", "logs_private", "no_logs"]) {
    const fixture = handlerFixture({ lookupError: new RaidLogError(code) });
    await fixture.run();
    assert.ok(!fixture.calls.some(call => call[0] === "capture"));
    assert.doesNotMatch(fixture.calls.at(-1)[1].content, /raid-log\./);
  }
});
