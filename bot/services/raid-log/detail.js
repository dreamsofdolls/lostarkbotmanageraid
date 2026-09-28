"use strict";

const { bibleButton, OVERVIEW_BUTTON } = require("./page-controls");

// Runs in the browser. Capture the whole selected-player section, including
// the analysis cards and charts below the skill table, in two ordered images.
function inspectPlayerPage({ player, playerCount, partyCount }) {
  const hero = document.querySelector("h1")?.closest(".max-w-7xl");
  const back = document.querySelector('[aria-label="Return to Overview"]');
  const table = back?.closest("table");
  const label = table?.querySelector("tbody tr td:nth-child(2) .truncate")?.innerText.trim();
  if (!hero || !table || label !== player.label) return { error: "incomplete" };
  let card = table;
  while (card.parentElement && !card.innerText.includes("Total DMG:")) card = card.parentElement;
  if (card === document.body || !card.innerText.includes("Total DMG:")) return { error: "incomplete" };
  const content = card.parentElement;
  const headerRect = hero.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const x = Math.floor(Math.min(headerRect.left, contentRect.left) + scrollX);
  const y = Math.floor(headerRect.top + scrollY);
  const right = Math.ceil(Math.max(headerRect.right, contentRect.right) + scrollX);
  const bottom = Math.ceil(contentRect.bottom + scrollY);
  const full = { x, y, width: right - x, height: bottom - y };
  const tables = [...content.querySelectorAll("table")].filter(t => t.getBoundingClientRect().height > 0);
  const fits = element => {
    const rect = element.getBoundingClientRect();
    return element.scrollWidth <= element.clientWidth + 1 && rect.left + scrollX >= x
      && rect.right + scrollX <= right && rect.bottom + scrollY <= bottom;
  };
  const images = [...document.images].filter(img => hero.contains(img) || content.contains(img));
  if (x < 0 || y < 0 || full.width <= 0 || full.height <= 0 || full.height > 9800
    || !tables.every(fits) || document.fonts.status !== "loaded"
    || images.some(img => !img.complete || !img.naturalWidth)) return { error: "incomplete" };

  // Prefer a gap between cards near the midpoint, then a row boundary. A small
  // overlap keeps the join readable even when the only possible cut is a chart.
  const middle = y + full.height / 2;
  const nearest = elements => elements.map(element => Math.floor(element.getBoundingClientRect().top + scrollY) - 8)
    .filter(top => top > y + full.height * 0.3 && top < y + full.height * 0.7
      && top - y < 4900 && bottom - top < 4900)
    .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
  const split = nearest([...content.children]) ?? nearest([...table.querySelectorAll("tbody tr")]) ?? Math.floor(middle);
  const clips = [
    { x, y, width: full.width, height: split - y + 8 },
    { x, y: split - 8, width: full.width, height: bottom - split + 8 },
  ];
  return {
    title: document.title.replace(/\s*\|\s*lostark\.bible\s*$/i, ""),
    header: hero.innerText.split(/\s+Uploaded by\b/)[0].trim().replace(/\n{3,}/g, "\n\n"),
    summary: card.innerText.split(/Damage\s+Party Buffs/)[0].trim(),
    playerCount, partyCount, player, full, clips,
    hasBreakdown: [...document.querySelectorAll("button")].some(button => button.innerText.trim() === "By Category"),
    links: ["View Character Profile", "View Loadout Snapshot"].flatMap(title => {
      const href = table.querySelector(`a[title="${title}"]`)?.href;
      if (!href) return [];
      const url = new URL(href);
      return url.origin === location.origin && url.pathname.startsWith("/character/") ? [{ title, url: url.href }] : [];
    }),
  };
}

async function selectPlayer(page, player) {
  await bibleButton(page, "Damage").click();
  const parties = page.locator("table").filter({ hasText: /^Party\s+\d+/ });
  const cell = parties.nth(player.party - 1).locator("tbody tr").nth(player.row).locator("td").nth(1);
  // Validate the displayed label at the slot; never reveal a hidden name or
  // silently select a different character if the source changes row order.
  if ((await cell.locator(".truncate").first().innerText()).trim() !== player.label) return false;
  // Names open a hover card with profile links. Dispatch on the validated
  // table cell itself so pointer placement cannot follow one of those links.
  await cell.dispatchEvent("click");
  await bibleButton(page, OVERVIEW_BUTTON).waitFor({ state: "visible" });
  return true;
}

module.exports = { inspectPlayerPage, selectPlayer };
