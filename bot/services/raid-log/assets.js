"use strict";

// Runs in the page. Match the hero and content used by the capture inspectors.
// Lazy images inside the capture must load even when below the viewport.
async function captureAssetsReady(player = false) {
  const hero = document.querySelector("h1")?.closest(".max-w-7xl");
  let card = player
    ? document.querySelector('[aria-label="Return to Overview"]')?.closest("table")
    : [...document.querySelectorAll("table")].find(table => table.getBoundingClientRect().height > 0);
  if (!hero || !card) return false;
  while (card.parentElement && !card.innerText.includes("Total DMG:")) card = card.parentElement;
  if (card === document.body || !card.innerText.includes("Total DMG:")) return false;
  const content = player ? card.parentElement : card;
  const images = [...document.images].filter(img => hero.contains(img) || content.contains(img));
  for (const img of images) if (img.loading === "lazy") img.loading = "eager";
  if (document.fonts.status !== "loaded" || images.some(img => !img.complete)) return false;
  const sources = images.map(img => img.currentSrc || img.src);
  await Promise.all(images.map(img => img.decode().catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // Hydration can replace an icon after the first readiness check. Wait for
  // the current set of assets, not the one that happened to exist before decode.
  const current = [...document.images].filter(img => hero.contains(img) || content.contains(img));
  return hero.isConnected && content.isConnected && document.fonts.status === "loaded"
    && current.length === images.length && current.every((img, index) => img === images[index]
      && img.complete && (img.currentSrc || img.src) === sources[index]);
}

module.exports = { captureAssetsReady };
