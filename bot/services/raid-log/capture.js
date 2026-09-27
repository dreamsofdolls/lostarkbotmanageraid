"use strict";

const { createBibleHttpError } = require("../auto-manage/bible/rate-limit");
const { RaidLogError } = require("./errors");
const { BIBLE_ORIGIN, parsePublicLogUrl } = require("./source");
const { readCaptureMemory } = require("./memory");
const { RAID_LOG_TABS } = require("./tabs");
const { createImageCache } = require("./image-cache");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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

// Runs in the page. Read the original UI without changing styles or data.
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
  const full = clip(headerRect.top, lastTable.bottom + 16);
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
    return { error: "incomplete" };
  }
  return {
    title: document.title.replace(/\s*\|\s*lostark\.bible\s*$/i, ""),
    header: hero.innerText.split(/\s+Uploaded by\b/)[0].trim().replace(/\n{3,}/g, "\n\n"),
    summary: card.innerText.split(/Damage\s+Party Buffs|Party\s+1/)[0].trim(),
    playerCount, partyCount: parties.length || expectedParties, team, full,
  };
}

function createRaidLogCapture({
  bibleLimiter,
  launchBrowser = options => require("playwright").chromium.launch(options),
  timeoutMs = 60_000,
  idleMs = 0,
  log: logger = console,
} = {}) {
  let busy = false;
  let warm;
  let idleTimer;
  let disposing = Promise.resolve();
  const cache = createImageCache();

  function closeResource(resource) {
    if (!resource) return disposing;
    resource.closing ||= resource.browser.close().catch(error => {
      logger.warn?.(`[raid-log] browser cleanup: ${error.message}`);
    });
    disposing = resource.closing;
    return disposing;
  }

  async function waitForAssets(page) {
    await page.waitForFunction(() => document.fonts.status === "loaded"
      && Array.from(document.images).every(img => img.complete));
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(img => img.decode().catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  }

  async function capturePage(log, { view, tab, bracketed }, deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new RaidLogError("timeout");
    clearTimeout(idleTimer);
    let resource = warm;
    warm = null;
    let succeeded = false;
    let expired = false;
    let stage = "launch";
    let clip;
    const memoryBefore = await readCaptureMemory();
    const timer = setTimeout(() => {
      expired = true;
      void closeResource(resource);
    }, Math.max(1, deadline - Date.now()));
    timer.unref?.();
    try {
      await disposing;
      if (expired || Date.now() >= deadline) throw new RaidLogError("timeout");
      if (resource?.crashed) { await closeResource(resource); resource = null; }
      if (!resource) {
        try {
          const browser = await launchBrowser({ headless: true, channel: "chromium", timeout: Math.min(remainingMs, 15_000) });
          resource = { browser, url: log.url, crashed: false };
        } catch (error) {
          throw new RaidLogError("browser_unavailable", error);
        }
        if (expired) throw new RaidLogError("timeout");
        const opened = resource;
        opened.browser.on("disconnected", () => { opened.crashed = true; });
        const context = await opened.browser.newContext({
          // Keep the desktop layout at one pixel per CSS pixel.
          viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1,
          locale: "en-GB", timezoneId: "Asia/Ho_Chi_Minh",
          serviceWorkers: "block", acceptDownloads: false,
        });
        await context.route("**/*", route => {
          const request = route.request();
          return isAllowedRequest(request.url(), request.isNavigationRequest(), opened.url, request.resourceType())
            ? route.continue() : route.abort();
        });
        opened.page = await context.newPage();
        opened.page.on("crash", () => { opened.crashed = true; });
      }
      if (expired) throw new RaidLogError("timeout");
      const page = resource.page;
      page.setDefaultTimeout(12_000);
      if (resource.url !== log.url || !resource.baseline) {
        resource.url = log.url;
        resource.baseline = null;
        stage = "navigation";
        const response = await page.goto(log.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (!response?.ok()) {
          if (response?.status() === 429) {
            throw createBibleHttpError("LostArk Bible HTTP 429", {
              status: 429, headers: { get: name => response.headers()[name] },
            });
          }
          throw new RaidLogError("unavailable");
        }
        await page.getByRole("button", { name: "Damage", exact: true }).click();
        await page.locator("table").filter({ hasText: "Party 1" }).waitFor({ state: "visible" });
        await waitForAssets(page);
        resource.baseline = await page.evaluate(inspectDamagePage);
        if (resource.baseline.error) throw new RaidLogError(resource.baseline.error);
      }
      stage = tab;
      try {
        await page.getByRole("button", { name: RAID_LOG_TABS[tab], exact: true }).click();
        const normalizedSwitch = page.getByRole("switch", { name: "Use normalized DPS percentiles" });
        if (await normalizedSwitch.isChecked() === bracketed) {
          await page.locator("label").filter({ has: normalizedSwitch }).click();
        }
        // Check the site's reactive state too, so an early click during
        // hydration cannot produce an image labelled as the wrong tab/mode.
        await page.waitForFunction(({ label, bracketed }) => {
          const active = Array.from(document.querySelectorAll("button"))
            .some(button => button.innerText.trim() === label && button.classList.contains("bg-accent-600"));
          const input = document.querySelector('input[aria-label="Use normalized DPS percentiles"]');
          return active && input?.checked === !bracketed
            && input.closest("label").querySelector("span").classList.contains("text-white") === bracketed;
        }, { label: RAID_LOG_TABS[tab], bracketed });
      } catch (error) {
        throw new RaidLogError("unavailable", error);
      }
      stage = "assets";
      await waitForAssets(page);
      await page.mouse.move(0, 0);
      const evidence = await page.evaluate(inspectDamagePage, {
        expectedPlayers: resource.baseline.playerCount, expectedParties: resource.baseline.partyCount,
      });
      if (evidence.error) throw new RaidLogError(evidence.error);
      clip = evidence[view];
      stage = "screenshot";
      const buffer = await page.screenshot({ clip, type: "png", scale: "css", animations: "disabled" });
      if (buffer.length > MAX_IMAGE_BYTES) throw new RaidLogError("too_large");
      succeeded = true;
      return { ...log, view, tab, bracketed, ...evidence, buffer,
        filename: `raid-log-${log.id}-${view}-${tab}-${bracketed ? "bracketed" : "normalized"}.png` };
    } catch (error) {
      if (expired || error.name === "TimeoutError") throw new RaidLogError("timeout", error);
      if (resource?.crashed || /(?:Target|Page) crashed/i.test(`${error.message} ${error.cause?.message || ""}`)) {
        logger.warn?.(`[raid-log] browser_crashed ${JSON.stringify({
          id: log.id, view, tab, bracketed, stage, clip, deviceScaleFactor: 1,
          memoryBefore, memoryAfter: await readCaptureMemory(), cause: error.cause?.message || error.message,
        })}`);
        throw new RaidLogError("browser_crashed", error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (succeeded && idleMs > 0 && !expired && !resource.crashed) {
        warm = resource;
        idleTimer = setTimeout(() => {
          warm = null;
          void closeResource(resource);
        }, idleMs);
        idleTimer.unref?.();
      } else await closeResource(resource);
    }
  }

  async function captureRaidLog(input, { view = "team", tab = "damage", bracketed = true, useCache = false } = {}) {
    const log = parsePublicLogUrl(input);
    if (!["team", "full"].includes(view)) throw new RaidLogError("invalid_view");
    if (!Object.hasOwn(RAID_LOG_TABS, tab) || typeof bracketed !== "boolean") throw new RaidLogError("invalid_selection");
    const key = `${log.id}:${view}:${tab}:${bracketed}`;
    const cached = useCache && cache.get(key);
    if (cached) return { ...cached, cached: true };
    if (busy) throw new RaidLogError("busy");
    // Claim synchronously, before launch or waiting on the shared Bible limiter.
    busy = true;
    const deadline = Date.now() + timeoutMs;
    const attempt = async () => {
      const options = { view, tab, bracketed };
      const result = await (bibleLimiter
        ? bibleLimiter.run(() => capturePage(log, options, deadline)) : capturePage(log, options, deadline));
      if (useCache) cache.set(key, result);
      return result;
    };
    try {
      try {
        return await attempt();
      } catch (error) {
        if (error.code !== "browser_crashed") throw error;
        // One fresh browser only; keep the original deadline, busy slot and
        // shared Bible backoff. capturePage has already closed the failed one.
        logger.warn?.(`[raid-log] retrying capture once after browser crash id=${log.id} view=${view}`);
        return await attempt();
      }
    } finally {
      busy = false;
    }
  }
  captureRaidLog.close = () => {
    clearTimeout(idleTimer);
    const resource = warm;
    warm = null;
    return closeResource(resource);
  };
  return captureRaidLog;
}

module.exports = { createRaidLogCapture, isAllowedRequest, inspectDamagePage };
