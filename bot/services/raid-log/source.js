"use strict";

const { RaidLogError } = require("./errors");
const BIBLE_ORIGIN = "https://lostark.bible";

function parsePublicLogUrl(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  // Validate before URL normalization so traversal, credentials, ports and
  // lookalike domains cannot turn into an accepted log address.
  const match = /^https:\/\/lostark\.bible\/logs\/([A-Za-z0-9_-]{1,64})\/?$/.exec(raw);
  if (!match) throw new RaidLogError("invalid_url");
  return { id: match[1], url: `${BIBLE_ORIGIN}/logs/${match[1]}` };
}

function normalizeCharacterName(value) {
  return String(value || "").trim().normalize("NFC").toLowerCase();
}

function parseRaidLogSource({ character, url } = {}) {
  const name = typeof character === "string" ? character.trim().normalize("NFC") : "";
  const link = typeof url === "string" ? url.trim() : "";
  if (Boolean(name) === Boolean(link)) throw new RaidLogError("invalid_source");
  if (link) return { url: parsePublicLogUrl(link).url };
  if (name.length > 64 || !/^[\p{L}\p{M}\p{N}]+$/u.test(name)) throw new RaidLogError("invalid_character");
  return { character: name };
}

module.exports = { BIBLE_ORIGIN, parsePublicLogUrl, parseRaidLogSource, normalizeCharacterName };
