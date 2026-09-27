"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRaidLogSource } = require("../bot/services/raid-log/source");

test("source requires exactly one valid name or public log URL, preserving Unicode accents", () => {
  assert.deepEqual(parseRaidLogSource({ character: "  SátuRn  " }), { character: "SátuRn" });
  assert.deepEqual(parseRaidLogSource({ url: "https://lostark.bible/logs/ABC/" }), { url: "https://lostark.bible/logs/ABC" });
  for (const input of [{}, { character: "  " }, { character: "Saturn", url: "https://lostark.bible/logs/ABC" }]) {
    assert.throws(() => parseRaidLogSource(input), { code: "invalid_source" });
  }
  for (const character of ["../logs/a", "two names", "https://example.com", "a".repeat(65), "name\nother"]) {
    assert.throws(() => parseRaidLogSource({ character }), { code: "invalid_character" });
  }
});
