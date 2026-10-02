"use strict";

const { createBibleHttpError } = require("../auto-manage/bible/rate-limit");
const { RaidLogError } = require("./errors");
const { BIBLE_ORIGIN, parsePublicLogUrl } = require("./source");
const { readCaptureMemory, shouldReleaseBrowser } = require("./memory");
const { tabsForPlayer } = require("./tabs");
const { createImageCache } = require("./image-cache");
const { createAssetCache } = require("./asset-cache");
const { frameCaptureImage } = require("./image-frame");
const { inspectPlayerPage, selectPlayer } = require("./detail");
const { selectCaptureTab, fitCaptureTables, waitForCharts, returnToOverview, bibleButton, waitForPartyTables } = require("./page-controls");
const { collectTeamMetrics } = require("./team-metrics");
const { captureAssetsReady } = require("./assets");
const { createRenderQueue } = require("./render-queue");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_NAVIGATIONS = 4;

function isAllowedRequest(requestUrl, isNavigation, logUrl, resourceType) {
  try {
    const url = new URL(requestUrl);
    if (url.username || url.password) return false;
    // Bible serves battle-item icons from this CDN. Permit images only there.
    if (!isNavigation && resourceType === "image" && url.origin === "https://cdn.ags.lol") return true;
    if (url.origin !== BIBLE_ORIGIN) return false;
    // Keep page navigation on the selected log, not a sign-in page or arbitrary URL.
    return !isNavigation || url.href === logUrl || url.href === `${logUrl}/`;
  } catch {
    return false;
  }
}

/**
 * Runs in the page. Read the original UI without changing styles or data.
 * @param {{ expectedPlayers?: number, expectedParties?: number }} [options] baseline counts
 * @returns {object} capture bounds and players, or an incomplete-page error
 */
function inspectDamagePage({ expectedPlayers, expectedParties } = {}) {
  const tables = Array.from(document.querySelectorAll("table"))
    .filter(table => table.getBoundingClientRect().height > 0);
  const parties = tables.filter(table => /^Party\s+\d+/.test(table.innerText.trim()));
  const hero = document.querySelector("h1")?.closest(".max-w-7xl");
  if (!hero || !tables.length || (!parties.length && !expectedPlayers)) return { error: "incomplete" };
  const playerTables = parties.length ? parties : tables;
  let card = playerTables[0];
  while (card.parentElement && !card.innerText.includes("Total DMG:")) card = card.parentElement;
  if (!card.innerText.includes("Total DMG:") || card === document.body) return { error: "incomplete" };

  const headerRect = hero.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const lastParty = playerTables.at(-1).getBoundingClientRect();
  const cardTables = tables.filter(table => card.contains(table));
  const lastTable = cardTables.at(-1).getBoundingClientRect();
  const x = Math.floor(Math.min(headerRect.left, cardRect.left) + scrollX);
  const right = Math.ceil(Math.max(headerRect.right, cardRect.right) + scrollX);
  const clip = (top, bottom) => ({ x, y: Math.floor(top + scrollY), width: right - x,
    height: Math.ceil(bottom + scrollY) - Math.floor(top + scrollY) });
  const team = clip(cardRect.top, lastParty.bottom + 4);
  const full = clip(headerRect.top, Math.max(lastTable.bottom + 16, card.parentElement.getBoundingClientRect().bottom));
  const playerCount = playerTables.reduce((sum, table) => sum + table.querySelectorAll("tbody tr").length, 0);
  const fits = (element, region) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.scrollWidth <= element.clientWidth + 1
      && rect.left + scrollX >= region.x && rect.right + scrollX <= region.x + region.width
      && rect.top + scrollY >= region.y && rect.bottom + scrollY <= region.y + region.height;
  };
  const partyTablesFit = playerTables.every(table => fits(table, team)
    && Array.from(table.querySelectorAll("tbody tr")).every(row => fits(row, team)));
  const allTablesFit = cardTables.every(table => fits(table, full));
  const validBounds = team.x >= 0 && full.y >= 0 && full.height <= 5000
    && team.height > 0 && full.height > 0;
  if (playerCount < 1 || playerCount > 16 || (expectedPlayers && playerCount !== expectedPlayers)
    || !partyTablesFit || !allTablesFit || !validBounds) {
    return { error: "incomplete" };
  }

  // Only assets within the capture matter; unrelated lazy-loaded site images
  // must not make an otherwise complete Damage capture fail.
  const images = Array.from(document.images).filter(img => hero.contains(img) || card.contains(img));
  if (document.fonts.status !== "loaded" || images.some(img => !img.complete || !img.naturalWidth)) {
    return { error: "incomplete", pendingAssets: true };
  }
  return {
    title: document.title.replace(/\s*\|\s*lostark\.bible\s*$/i, ""),
    header: hero.innerText.split(/\s+Uploaded by\b/)[0].trim().replace(/\n{3,}/g, "\n\n"),
    summary: card.innerText.split(/Damage\s+Party Buffs|Party\s+1/)[0].trim(),
    playerCount, partyCount: parties.length || expectedParties, team, full,
    players: parties.flatMap((party, partyIndex) => [...party.querySelectorAll("tbody tr")].map((row, rowIndex) => ({
      id: `${partyIndex + 1}-${rowIndex}`, party: partyIndex + 1, row: rowIndex,
      label: (row.cells[1]?.querySelector(".truncate")?.innerText || row.cells[1]?.innerText || "").trim(),
      className: row.querySelector('img[src*="/classes/"]')?.alt || "",
    }))),
  };
}

/**
 * @param {object} [options] browser, queue and image-processing dependencies
 * @returns {Function} queued capture function with a close method for its idle browser and caches
 */
function createRaidLogCapture({
  bibleLimiter,
  launchBrowser = options => require("playwright").chromium.launch(options),
  timeoutMs = 60_000,
  idleMs = 0,
  maxPending = 4,
  log: logger = console,
  readMemory = readCaptureMemory,
  frameImage = frameCaptureImage,
} = {}) {
  const queue = createRenderQueue({ maxPending });
  let warm;
  let idleTimer;
  let disposing = Promise.resolve();
  const cache = createImageCache();
  const assets = createAssetCache();
  const pendingCaptures = new Map();

  function closeResource(resource) {
    if (!resource) return disposing;
    resource.closing ||= resource.browser.close().catch(error => {
      logger.warn(`[raid-log] browser cleanup: ${error.message}`);
    });
    disposing = resource.closing;
    return disposing;
  }

  async function capturePage(log, { view, tab, bracketed, player, refresh }, deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new RaidLogError("timeout");
    clearTimeout(idleTimer);
    let resource = warm;
    warm = null;
    let succeeded = false;
    let expired = false;
    let stage = "launch";
    let clip;
    let memoryAtScreenshot;
    const controller = new AbortController();
    let rejectDeadline;
    let settleDeadline;
    const deadlineReached = new Promise((resolve, reject) => {
      settleDeadline = resolve;
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      expired = true;
      const error = new RaidLogError("timeout");
      controller.abort(error);
      rejectDeadline(error);
      void closeResource(resource);
    }, Math.max(1, deadline - Date.now()));
    timer.unref?.();
    const readMemoryBeforeDeadline = () => Promise.race([readMemory(), deadlineReached]);
    let memoryBefore;
    try {
      memoryBefore = await readMemoryBeforeDeadline();
      await disposing;
      if (expired || Date.now() >= deadline) throw new RaidLogError("timeout");
      if (resource && (resource.crashed || shouldReleaseBrowser(memoryBefore))) {
        await closeResource(resource);
        resource = null;
      }
      const needsNavigation = refresh || !resource || resource.url !== log.url || !resource.baseline;
      async function preparePage() {
        controller.signal.throwIfAborted();
        if (!resource) {
          try {
            // Playwright's headless shell avoids the full Chrome process set.
            const browser = await launchBrowser({ headless: true, timeout: Math.min(deadline - Date.now(), 15_000) });
            resource = { browser, url: log.url, crashed: false, navigations: 0 };
          } catch (error) {
            throw new RaidLogError("browser_unavailable", error);
          }
          if (expired) throw new RaidLogError("timeout");
          const opened = resource;
          opened.browser.on("disconnected", () => { opened.crashed = true; });
        }
        // Playwright retains request/response bodies in the browser context.
        // Periodic recycling bounds that history while keeping Chromium warm.
        if (needsNavigation && resource.navigations >= MAX_CONTEXT_NAVIGATIONS) {
          await resource.context.close();
          resource.page = null;
          resource.navigations = 0;
        }
        if (!resource.page) {
          const opened = resource;
          const context = opened.context = await opened.browser.newContext({
            // Keep the desktop layout at one pixel per CSS pixel.
            viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1,
            locale: "en-GB", timezoneId: "Asia/Ho_Chi_Minh",
            serviceWorkers: "block", acceptDownloads: false,
          });
          await context.route("**/*", route => {
            const request = route.request();
            if (!isAllowedRequest(request.url(), request.isNavigationRequest(), opened.url, request.resourceType())) return route.abort();
            const asset = assets.get(request);
            return asset ? assets.fulfill(route, asset) : route.continue();
          });
          opened.page = await context.newPage();
          opened.page.on("crash", () => { opened.crashed = true; });
          opened.page.on("response", response => { assets.remember(response); });
        }
        controller.signal.throwIfAborted();
        const page = resource.page;
        page.setDefaultTimeout(12_000);
        await page.setViewportSize({ width: 1600, height: 1200 });
        await page.evaluate(() => {
          for (const container of document.querySelectorAll(".max-w-7xl")) container.style.maxWidth = "";
        });
      }
      if (needsNavigation) {
        const navigate = async () => {
          await preparePage();
          resource.url = log.url;
          resource.baseline = null;
          resource.player = null;
          resource.navigations++;
          stage = "navigation";
          const response = await resource.page.goto(log.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          if (!response?.ok()) {
            if (response?.status() === 429) {
              throw createBibleHttpError("LostArk Bible HTTP 429", {
                status: 429, headers: { get: name => response.headers()[name] },
              });
            }
            throw new RaidLogError("unavailable");
          }
        };
        // Only page loading uses a Bible slot; local tabs and PNG encoding do not.
        await (bibleLimiter ? bibleLimiter.run(navigate, { signal: controller.signal }) : navigate());
      } else await preparePage();
      const page = resource.page;
      async function readEvidence(inspect, options) {
        let evidence = await page.evaluate(inspect, options);
        // Hydration can replace icons between asset readiness and DOM readback.
        // Resample only that transient state; invalid geometry still fails.
        while (evidence.pendingAssets) {
          controller.signal.throwIfAborted();
          await page.waitForFunction(captureAssetsReady, inspect === inspectPlayerPage);
          evidence = await page.evaluate(inspect, options);
        }
        return evidence;
      }
      if (needsNavigation) {
        // SSR controls can exist before hydration binds their events. Let
        // the initial modules and percentile requests settle before clicking.
        await page.waitForLoadState("networkidle", { timeout: 12_000 });
        await bibleButton(page, "Damage").click();
        await waitForPartyTables(page);
        await page.waitForFunction(captureAssetsReady, false);
        resource.baseline = await readEvidence(inspectDamagePage);
        if (resource.baseline.error) throw new RaidLogError(resource.baseline.error);
        stage = "team-metrics";
        resource.baseline.players = await collectTeamMetrics(page, resource.baseline.players, {
          logId: log.id, summary: resource.baseline.summary, log: logger,
        });
        stage = "navigation";
      }
      // Detail builds thousands of chart/skill nodes. Reclaim the previous
      // view's temporary allocations before starting another render.
      if (player || resource.player) {
        stage = "detail-memory";
        await page.requestGC();
        controller.signal.throwIfAborted();
      }
      if ((resource.player?.id || null) !== (player?.id || null)) {
        stage = "player";
        if (resource.player) await returnToOverview(page);
        if (player) {
          const current = resource.baseline.players.find(entry => entry.id === player.id && entry.label === player.label);
          if (!current || !await selectPlayer(page, current)) throw new RaidLogError("invalid_selection");
          player = current;
          // The detail exists now; reclaim construction garbage before tab
          // selection can trigger another render of it.
          await page.requestGC();
          controller.signal.throwIfAborted();
        }
        resource.player = player;
      }
      stage = tab;
      try {
        await selectCaptureTab(page, { tab, bracketed, player });
        await fitCaptureTables(page);
      } catch (error) {
        throw new RaidLogError("unavailable", error);
      }
      stage = "assets";
      await page.waitForFunction(captureAssetsReady, Boolean(player));
      await waitForCharts(page);
      await page.mouse.move(0, 0);
      const evidence = player
        ? await readEvidence(inspectPlayerPage, { player, playerCount: resource.baseline.playerCount, partyCount: resource.baseline.partyCount })
        : await readEvidence(inspectDamagePage, { expectedPlayers: resource.baseline.playerCount, expectedParties: resource.baseline.partyCount });
      if (evidence.error) throw new RaidLogError(evidence.error);
      stage = "screenshot";
      const filenameBase = `raid-log-${log.id}-${view}-${tab}-${bracketed ? "bracketed" : "normalized"}${player ? `-player-${player.id}` : ""}`;
      const images = [];
      for (const [index, region] of (player ? evidence.clips : [evidence[view]]).entries()) {
        clip = region;
        if (player) await page.requestGC();
        memoryAtScreenshot = await readMemoryBeforeDeadline();
        controller.signal.throwIfAborted();
        const screenshot = await page.screenshot({ clip, fullPage: view === "full", type: "png", scale: "css", animations: "disabled" });
        controller.signal.throwIfAborted();
        if (screenshot.length > MAX_IMAGE_BYTES) throw new RaidLogError("too_large");
        images.push({ buffer: screenshot, filename: `${filenameBase}${player ? `-${index === 0 ? "top" : "bottom"}` : ""}.png`, clip });
      }
      // Capture both detail halves before disposing of the page. Reclaim
      // Chromium under pressure before streaming the PNG frames.
      const beforeFraming = await readMemoryBeforeDeadline();
      if (idleMs <= 0 || shouldReleaseBrowser(beforeFraming)) {
        if (idleMs > 0) logger.info?.(`[raid-log] releasing browser before PNG framing id=${log.id} max=${beforeFraming.max} current=${beforeFraming.current}`);
        await closeResource(resource);
      }
      stage = "image-frame";
      for (const image of images) {
        controller.signal.throwIfAborted();
        const buffer = await frameImage(image.buffer, image.clip, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (buffer.length > MAX_IMAGE_BYTES) throw new RaidLogError("too_large");
        image.buffer = buffer;
      }
      if (!resource.closing && shouldReleaseBrowser(await readMemoryBeforeDeadline())) await closeResource(resource);
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new RaidLogError("timeout");
      succeeded = true;
      return { ...log, view, tab, bracketed, ...evidence, players: resource.baseline.players, images };
    } catch (error) {
      if (expired || error.name === "TimeoutError") throw new RaidLogError("timeout", error);
      if ((resource?.crashed && !resource.closing) || /(?:Target|Page) crashed/i.test(`${error.message} ${error.cause?.message || ""}`)) {
        logger.warn(`[raid-log] browser_crashed ${JSON.stringify({
          id: log.id, view, tab, bracketed, player: player?.label || "team", stage, clip, deviceScaleFactor: 1,
          browserMode: "headless-shell", memoryBefore, memoryAtScreenshot,
          memoryAfter: await readMemoryBeforeDeadline(), cause: error.cause?.message || error.message,
        })}`);
        const crashed = new RaidLogError("browser_crashed", error);
        crashed.stage = stage;
        throw crashed;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      settleDeadline();
      if (succeeded && idleMs > 0 && !expired && !resource.crashed && !resource.closing) {
        warm = resource;
        idleTimer = setTimeout(() => {
          warm = null;
          void closeResource(resource);
        }, idleMs);
        idleTimer.unref?.();
      } else await closeResource(resource);
    }
  }

  async function captureRaidLog(input, { view = "full", tab = "damage", bracketed = true, player = null, useCache = false, refresh = false } = {}) {
    const log = parsePublicLogUrl(input);
    if (!["team", "full"].includes(view)) throw new RaidLogError("invalid_view");
    if (!Object.hasOwn(tabsForPlayer(player), tab) || typeof bracketed !== "boolean"
      || (player && (view !== "full" || !/^\d+-\d+$/.test(player.id) || typeof player.label !== "string"))) throw new RaidLogError("invalid_selection");
    const key = `${log.id}:${view}:${tab}:${bracketed}:${player ? JSON.stringify([player.id, player.label]) : "team"}`;
    const prefix = `${log.id}:`;
    const fromCache = () => {
      if (!useCache || refresh) return;
      // A refresh queued behind another log has not invalidated its images yet.
      for (const [pendingKey, pending] of pendingCaptures) {
        if (pending.refresh && pendingKey.startsWith(prefix)) return;
      }
      return cache.get(key);
    };
    const cached = fromCache();
    if (cached) return { ...cached, cached: true };
    const shared = (useCache || refresh) && pendingCaptures.get(key);
    if (shared && (!refresh || shared.refresh)) return { ...await shared.promise, cached: true };
    if (refresh) {
      // New requests must queue behind the refresh rather than join an older capture.
      for (const pendingKey of pendingCaptures.keys()) if (pendingKey.startsWith(prefix)) pendingCaptures.delete(pendingKey);
    }
    const started = Date.now();
    const deadline = started + timeoutMs;
    const capture = queue.run(async () => {
      const queueMs = Date.now() - started;
      // Another queued request may already have rendered this exact view.
      const ready = fromCache();
      if (ready) return { ...ready, cached: true, queueMs };
      if (refresh) cache.invalidateLog(log.id);
      const attempt = () => capturePage(log, {
        view, tab, bracketed, player, refresh,
      }, deadline);
      let result;
      try {
        result = await attempt();
      } catch (error) {
        if (error.code !== "browser_crashed") throw error;
        // One retry within the original budget; the failed browser is closed.
        logger.warn(`[raid-log] retrying capture once after browser crash id=${log.id} view=${view}`);
        result = await attempt();
      }
      if (useCache) cache.set(key, result);
      return { ...result, queueMs };
    }, deadline);
    if (!useCache && !refresh) return capture;
    const pending = { promise: capture, refresh };
    pendingCaptures.set(key, pending);
    try { return await capture; }
    finally { if (pendingCaptures.get(key) === pending) pendingCaptures.delete(key); }
  }
  captureRaidLog.close = () => {
    clearTimeout(idleTimer);
    cache.clear();
    assets.clear();
    const resource = warm;
    warm = null;
    return closeResource(resource);
  };
  return captureRaidLog;
}

module.exports = { createRaidLogCapture, isAllowedRequest, inspectDamagePage, MAX_IMAGE_BYTES };
