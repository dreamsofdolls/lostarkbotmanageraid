"use strict";

const { JSDOM, VirtualConsole } = require("jsdom");
const { getClassName } = require("../../models/Class");
const { parseItemLevel } = require("../../utils/raid/common/shared");
const {
  createBibleHttpError,
} = require("../auto-manage/bible/rate-limit");
const {
  BIBLE_ORIGIN,
  BIBLE_REGION,
  BIBLE_REQUEST_TIMEOUT_MS,
} = require("../bible-endpoint");

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

  // One character of the page's `roster:[...]` data payload, in the key order
  // lostark.bible serialises it. If that order changes, nothing matches and
  // the fetch falls back to the rendered cards alone.
  const ROSTER_PAYLOAD_ENTRY = /\{id:\d+,name:"((?:[^"\\]|\\.)*)",class:"((?:[^"\\]|\\.)*)",ilvl:([\d.]+),combatPower:(?:null|\{id:\d+,score:([\d.]+)\}),combatPowerIsEstimate:(true|false)/g;

  // The cards print item level and CP rounded to two decimals, trailing
  // zeros dropped ("1722.5"); payload records are read the same way.
  function roundPayloadNumber(value) {
    return Number(Number(value).toFixed(2));
  }

  function extractRosterPayloadFromHtml(html) {
    const start = html.indexOf("roster:[");
    if (start < 0) return [];
    // Entries hold objects but no arrays, so the first ']' closes the list.
    const end = html.indexOf("]", start);
    const payload = html.slice(start, end < 0 ? html.length : end);
    const entries = [...payload.matchAll(ROSTER_PAYLOAD_ENTRY)];
    // A payload that lists characters but matches nothing means bible
    // changed its shape, and stale alts silently drop out again.
    if (entries.length === 0 && /\bname"?\s*:/.test(payload)) {
      console.warn("[roster] roster payload found but no character matched its expected shape");
    }
    return entries.map(([, name, classId, ilvl, score, estimate]) => ({
      charName: unescapeJsonLike(name),
      className: getClassName(unescapeJsonLike(classId)),
      itemLevel: roundPayloadNumber(ilvl),
      combatScore: score ? `${estimate === "true" ? "≈" : ""}${roundPayloadNumber(score)}` : "?",
    }));
  }

  // lostark.bible renders a card only for characters it updated recently, so
  // an alt not refreshed for a few weeks is in the payload alone. It is
  // inserted by item level, where its card would have been. A page with no
  // cards (a hidden or missing roster) stays empty.
  function addPayloadOnlyCharacters(characters, html) {
    if (characters.length === 0) return characters;
    const listed = new Set(characters.map((character) => character.charName.toLowerCase()));
    for (const record of extractRosterPayloadFromHtml(html)) {
      const key = record.charName.toLowerCase();
      if (!record.charName || listed.has(key) || !(record.itemLevel > 0)) continue;
      listed.add(key);
      const at = characters.findIndex((character) => character.itemLevel < record.itemLevel);
      characters.splice(at < 0 ? characters.length : at, 0, record);
    }
    return characters;
  }

  async function fetchRosterCharacters(seedCharacterName) {
    return bibleLimiter.run(() => fetchRosterCharactersRaw(seedCharacterName));
  }

  async function fetchRosterCharactersRaw(seedCharacterName) {
    const targetUrl = `${BIBLE_ORIGIN}/character/${BIBLE_REGION}/${encodeURIComponent(seedCharacterName)}/roster`;
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      signal: AbortSignal.timeout(BIBLE_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw createBibleHttpError(
        `LostArk Bible HTTP ${response.status}`,
        response
      );
    }

    const html = await response.text();
    const { document } = new JSDOM(html, { virtualConsole: jsdomVirtualConsole }).window;
    const rosterClassMap = extractRosterClassMapFromHtml(html);
    const links = document.querySelectorAll(`a[href^="/character/${BIBLE_REGION}/"]`);

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

    return addPayloadOnlyCharacters(characters, html);
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
