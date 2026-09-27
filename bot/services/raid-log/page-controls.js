"use strict";

const { captureTabOptions } = require("./tabs");

const NORMALIZED_SWITCH = "Use normalized DPS percentiles";

async function selectCaptureTab(page, { tab, bracketed, player }) {
  const options = captureTabOptions(tab);
  await page.getByRole("button", { name: options.button, exact: true }).click();
  if (options.allBuffs !== undefined) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const item = page.getByRole("menuitem").filter({ hasText: "Offensive Buffs Only" });
    if (await item.locator("input").isChecked() === options.allBuffs) await item.locator("label").click();
    await page.keyboard.press("Escape");
  }
  if (options.sub) await page.getByRole("button", { name: options.sub, exact: true }).click();
  const sub = player ? options.breakdown || "By Source" : options.chart || "Average DPS";
  const subButton = page.getByRole("button", { name: sub, exact: true });
  // Older logs can lack the damage attribution analysis, but still have skills.
  if (options.breakdown || options.chart || await subButton.count()) await subButton.click();
  await setNormalized(page, !bracketed);
  await page.waitForFunction(label => [...document.querySelectorAll("button")]
    .some(button => button.innerText.trim() === label && button.classList.contains("bg-accent-600")), options.button);
}

/**
 * @param {object} page Playwright page on a Damage view
 * @param {boolean} on true for Normalized percentiles, false for Bracketed
 * @returns {Promise<void>}
 */
async function setNormalized(page, on) {
  const toggle = page.getByRole("switch", { name: NORMALIZED_SWITCH });
  if (await toggle.isChecked() !== on) await page.locator("label").filter({ has: toggle }).click();
  // The input flips on click; the label's white text in Bracketed mode comes
  // with Bible's re-render, so waiting on both waits for the redrawn table.
  await page.waitForFunction(({ name, on }) => {
    const input = document.querySelector(`input[aria-label="${name}"]`);
    return input?.checked === on && input.closest("label").querySelector("span").classList.contains("text-white") === !on;
  }, { name: NORMALIZED_SWITCH, on });
}

/**
 * Leaves a player's detail view for the team overview.
 * @param {object} page
 * @returns {Promise<void>}
 */
async function returnToOverview(page) {
  await page.getByRole("button", { name: "Return to Overview", exact: true }).click();
  await page.locator("table").filter({ hasText: "Party 1" }).waitFor({ state: "visible" });
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

module.exports = { selectCaptureTab, fitCaptureTables, waitForCharts, setNormalized, returnToOverview };
