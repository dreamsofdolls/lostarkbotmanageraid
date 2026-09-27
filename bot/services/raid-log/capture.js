"use strict";

const { createBibleHttpError } = require("../auto-manage/bible/rate-limit");
const { RaidLogError } = require("./errors");
const { BIBLE_ORIGIN, parsePublicLogUrl } = require("./source");

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
function inspectDamagePage() {
  const tables = Array.from(document.querySelectorAll("table"))
    .filter(table => table.getBoundingClientRect().height > 0);
  const parties = tables.filter(table => /^Party\s+\d+/.test(table.innerText.trim()));
  const hero = document.querySelector("h1")?.closest(".max-w-7xl");
  if (!hero || !parties.length) return { error: "incomplete" };
  let card = parties[0];
  while (card.parentElement && !card.innerText.includes("Total DMG:")) card = card.parentElement;
  if (!card.innerText.includes("Total DMG:") || card === document.body) return { error: "incomplete" };

  const headerRect = hero.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const lastParty = parties.at(-1).getBoundingClientRect();
  const cardTables = tables.filter(table => card.contains(table));
  const lastTable = cardTables.at(-1).getBoundingClientRect();
  const x = Math.floor(Math.min(headerRect.left, cardRect.left) + scrollX);
  const right = Math.ceil(Math.max(headerRect.right, cardRect.right) + scrollX);
  const clip = (top, bottom) => ({ x, y: Math.floor(top + scrollY), width: right - x,
    height: Math.ceil(bottom + scrollY) - Math.floor(top + scrollY) });
  const team = clip(cardRect.top, lastParty.bottom + 4);
  const full = clip(headerRect.top, lastTable.bottom + 16);
  const playerCount = parties.reduce((sum, table) => sum + table.querySelectorAll("tbody tr").length, 0);
  const fits = (element, region) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.scrollWidth <= element.clientWidth + 1
      && rect.left + scrollX >= region.x && rect.right + scrollX <= region.x + region.width
      && rect.top + scrollY >= region.y && rect.bottom + scrollY <= region.y + region.height;
  };
  const partyTablesFit = parties.every(table => fits(table, team)
    && Array.from(table.querySelectorAll("tbody tr")).every(row => fits(row, team)));
  const allTablesFit = cardTables.every(table => fits(table, full));
  const validBounds = team.x >= 0 && full.y >= 0 && full.height <= 5000
    && team.height > 0 && full.height > 0;
  if (playerCount < 1 || playerCount > 16 || !partyTablesFit || !allTablesFit || !validBounds) {
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
    summary: card.innerText.split(/Party\s+1/)[0].trim(),
    playerCount, partyCount: parties.length, team, full,
  };
}

function createRaidLogCapture({
  bibleLimiter,
  launchBrowser = options => require("playwright").chromium.launch(options),
  timeoutMs = 60_000,
} = {}) {
  let busy = false;

  async function capturePage(log, view) {
    let browser;
    let closing;
    let expired = false;
    const close = () => browser ? (closing ||= browser.close()) : Promise.resolve();
    const timer = setTimeout(() => {
      expired = true;
      void close().catch(() => {});
    }, timeoutMs);
    timer.unref?.();
    try {
      try {
        browser = await launchBrowser({ headless: true, channel: "chromium", timeout: Math.min(timeoutMs, 15_000) });
      } catch (error) {
        throw new RaidLogError("browser_unavailable", error);
      }
      if (expired) throw new RaidLogError("timeout");
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2,
        locale: "en-GB", timezoneId: "Asia/Ho_Chi_Minh",
        serviceWorkers: "block", acceptDownloads: false,
      });
      await context.route("**/*", route => {
        const request = route.request();
        return isAllowedRequest(request.url(), request.isNavigationRequest(), log.url, request.resourceType())
          ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12_000);
      const response = await page.goto(log.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (!response?.ok()) {
        if (response?.status() === 429) {
          throw createBibleHttpError("LostArk Bible HTTP 429", {
            status: 429, headers: { get: name => response.headers()[name] },
          });
        }
        throw new RaidLogError("unavailable");
      }
      try {
        await page.getByRole("button", { name: "Damage", exact: true }).click();
        await page.locator("table").filter({ hasText: "Party 1" }).waitFor({ state: "visible" });
      } catch (error) {
        throw new RaidLogError("unavailable", error);
      }
      await page.waitForFunction(() => document.fonts.status === "loaded"
        && Array.from(document.images).every(img => img.complete));
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images).map(img => img.decode().catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.mouse.move(0, 0);
      const evidence = await page.evaluate(inspectDamagePage);
      if (evidence.error) throw new RaidLogError(evidence.error);
      const buffer = await page.screenshot({ clip: evidence[view], type: "png", scale: "device" });
      if (buffer.length > MAX_IMAGE_BYTES) throw new RaidLogError("too_large");
      return { ...log, view, ...evidence, buffer, filename: `raid-log-${log.id}-${view}.png` };
    } catch (error) {
      if (expired || error.name === "TimeoutError") throw new RaidLogError("timeout", error);
      throw error;
    } finally {
      clearTimeout(timer);
      await close();
    }
  }

  return async function captureRaidLog(input, { view = "team" } = {}) {
    const log = parsePublicLogUrl(input);
    if (!["team", "full"].includes(view)) throw new RaidLogError("invalid_view");
    if (busy) throw new RaidLogError("busy");
    // Claim synchronously, before launch or waiting on the shared Bible limiter.
    busy = true;
    try {
      return await (bibleLimiter ? bibleLimiter.run(() => capturePage(log, view)) : capturePage(log, view));
    } finally {
      busy = false;
    }
  };
}

module.exports = { createRaidLogCapture, isAllowedRequest, inspectDamagePage };
