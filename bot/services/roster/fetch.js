"use strict";

const { JSDOM, VirtualConsole } = require("jsdom");
const { getClassName } = require("../../models/Class");
const { parseItemLevel } = require("../../utils/raid/common/shared");

const jsdomVirtualConsole = new VirtualConsole();
jsdomVirtualConsole.on("jsdomError", (err) => {
  if (err?.message?.includes("Could not parse CSS stylesheet")) return;
  console.error("[jsdom]", err);
});

function createRosterFetchService({ bibleLimiter }) {
  function unescapeJsonLike(value) {
    return String(value || "").replace(/\\(["\\/bfnrt])/g, (_, ch) => {
      switch (ch) {
        case "b": return "\b";
        case "f": return "\f";
        case "n": return "\n";
        case "r": return "\r";
        case "t": return "\t";
        default: return ch;
      }
    });
  }

  function extractRosterClassMapFromHtml(html) {
    const rosterClassMap = new Map();
    const regex = /name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*class:\s*"((?:[^"\\]|\\.)*)"/g;

    let match;
    while ((match = regex.exec(html)) !== null) {
      const charName = unescapeJsonLike(match[1]);
      const className = unescapeJsonLike(match[2]);
      if (!charName || !className) continue;
      rosterClassMap.set(charName, className);
    }

    return rosterClassMap;
  }

  async function fetchRosterCharacters(seedCharacterName) {
    return bibleLimiter.run(() => fetchRosterCharactersRaw(seedCharacterName));
  }

  async function fetchRosterCharactersRaw(seedCharacterName) {
    const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(seedCharacterName)}/roster`;
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`LostArk Bible HTTP ${response.status}`);
    }

    const html = await response.text();
    const { document } = new JSDOM(html, { virtualConsole: jsdomVirtualConsole }).window;
    const rosterClassMap = extractRosterClassMapFromHtml(html);
    const links = document.querySelectorAll('a[href^="/character/NA/"]');

    const characters = [];
    for (const link of links) {
      const headerDiv = link.querySelector(".text-lg.font-semibold");
      if (!headerDiv) continue;

      const charName = [...headerDiv.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent.trim())
        .find((text) => text.length > 0);

      if (!charName) continue;

      const spans = headerDiv.querySelectorAll("span");
      const itemLevelRaw = spans[0]?.textContent.trim() ?? "0";
      const combatScore = spans[1]?.textContent.trim() ?? "?";
      const itemLevel = parseItemLevel(itemLevelRaw);
      if (!Number.isFinite(itemLevel) || itemLevel <= 0) continue;

      characters.push({
        charName,
        className: getClassName(rosterClassMap.get(charName) ?? ""),
        itemLevel,
        combatScore,
      });
    }

    return characters;
  }

  return {
    fetchRosterCharacters,
    fetchRosterCharactersRaw,
    extractRosterClassMapFromHtml,
  };
}

module.exports = {
  createRosterFetchService,
};
