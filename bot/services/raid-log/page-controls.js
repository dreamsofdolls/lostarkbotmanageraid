"use strict";

const { captureTabOptions } = require("./tabs");

const NORMALIZED_SWITCH = "Use normalized DPS percentiles";
// The button that leaves a player's detail view.
const OVERVIEW_BUTTON = "Return to Overview";

/**
 * @param {object} page Playwright page
 * @param {string} name Bible's exact button label
 * @returns {object} locator
 */
function bibleButton(page, name) {
  return page.getByRole("button", { name, exact: true });
}

/**
 * Waits until the team overview shows its party tables.
 * @param {object} page
 * @returns {Promise<void>}
 */
function waitForPartyTables(page) {
  return page.locator("table").filter({ hasText: "Party 1" }).waitFor({ state: "visible" });
}

async function selectCaptureTab(page, { tab, bracketed, player }) {
  const options = captureTabOptions(tab);
  await bibleButton(page, options.button).click();
  if (options.allBuffs !== undefined) {
    await bibleButton(page, "Settings").click();
    const item = page.getByRole("menuitem").filter({ hasText: "Offensive Buffs Only" });
    if (await item.locator("input").isChecked() === options.allBuffs) await item.locator("label").click();
    await page.keyboard.press("Escape");
  }
  if (options.sub) await bibleButton(page, options.sub).click();
  const sub = player ? options.breakdown || "By Source" : options.chart || "Average DPS";
  const subButton = bibleButton(page, sub);
  // Older logs can lack the damage attribution analysis, but still have skills.
  if (options.breakdown || options.chart || await subButton.count()) await subButton.click();
  await setNormalized(page, !bracketed);
  await page.waitForFunction(label => [...document.querySelectorAll("button")]
    .some(button => button.innerText.trim() === label && button.classList.contains("bg-accent-600")), options.button);
}

/**
 * @param {object} page Playwright page on a Damage view
 * @param {boolean} on true for Normalized percentiles, false for Bracketed
 * @returns {Promise<boolean>} whether the log supports percentile modes
 */
async function setNormalized(page, on) {
  const toggle = page.getByRole("switch", { name: NORMALIZED_SWITCH });
  // Older encounters have no percentile analysis or mode switch.
  if (!await toggle.count()) return false;
  if (await toggle.isChecked() !== on) await page.locator("label").filter({ has: toggle }).click();
  // The input flips on click; the label's white text in Bracketed mode comes
  // with Bible's re-render, so waiting on both waits for the redrawn table.
  await page.waitForFunction(({ name, on }) => {
    const input = document.querySelector(`input[aria-label="${name}"]`);
    return input?.checked === on && input.closest("label").querySelector("span").classList.contains("text-white") === !on;
  }, { name: NORMALIZED_SWITCH, on });
  return true;
}

/**
 * Leaves a player's detail view for the team overview.
 * @param {object} page
 * @returns {Promise<void>}
 */
async function returnToOverview(page) {
  await bibleButton(page, OVERVIEW_BUTTON).click();
  await waitForPartyTables(page);
}

async function fitCaptureTables(page) {
  const width = await page.evaluate(() => {
    const tables = [...document.querySelectorAll("table")].filter(table => table.getBoundingClientRect().height > 0);
    return Math.ceil(Math.max(0, ...tables.filter(table => table.scrollWidth > table.parentElement.clientWidth)
      .map(table => table.scrollWidth))) + 96;
  });
  if (width <= 96) return;
  // All-buff views can be wider than Bible's fixed container. Widen only the
  // capture layout so every original column stays visible, at CSS pixel scale.
  if (width > 3200) throw new Error("Bible table exceeds the capture width limit");
  await page.setViewportSize({ width: Math.max(1600, width), height: 1200 });
  await page.evaluate(() => {
    for (const container of document.querySelectorAll(".max-w-7xl")) container.style.maxWidth = "calc(100vw - 64px)";
  });
}

async function waitForCharts(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const charts = [...document.querySelectorAll("svg")].filter(svg => svg.getBoundingClientRect().height > 150);
    if (!charts.length) return resolve();
    let quietTimer;
    const finish = error => {
      clearTimeout(quietTimer); clearTimeout(deadline); observer.disconnect();
      error ? reject(error) : resolve();
    };
    const settled = () => { clearTimeout(quietTimer); quietTimer = setTimeout(() => finish(), 200); };
    const observer = new MutationObserver(settled);
    const deadline = setTimeout(() => finish(new Error("Charts did not finish rendering")), 5000);
    for (const chart of charts) observer.observe(chart, { subtree: true, childList: true, attributes: true });
    settled();
  }));
}

module.exports = {
  selectCaptureTab, fitCaptureTables, waitForCharts, setNormalized, returnToOverview,
  bibleButton, waitForPartyTables, OVERVIEW_BUTTON,
};
