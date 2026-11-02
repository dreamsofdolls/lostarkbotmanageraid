"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ROSTER_ICON_UNKNOWN,
  chunkLinesIntoFields,
  countRoles,
  resolveRosterIcon,
} = require("../bot/handlers/roster/picker/render");
const { CLASS_EMOJI_MAP } = require("../bot/models/Class");

function mapEmoji(t, entries) {
  const previous = Object.fromEntries(Object.keys(entries).map((key) => [key, CLASS_EMOJI_MAP[key]]));
  Object.assign(CLASS_EMOJI_MAP, entries);
  t.after(() => Object.assign(CLASS_EMOJI_MAP, previous));
}

test("resolveRosterIcon prefers the character named like the roster", (t) => {
  mapEmoji(t, { Artist: "<:artist:1>", Bard: "<:bard:2>" });
  const icon = resolveRosterIcon("Qiylyn", [
    { name: "Bardly", className: "Bard", combatScore: "900" },
    { name: "Qiylyn", className: "Artist", combatScore: "100" },
  ]);
  assert.equal(icon, "<:artist:1>");
});

test("resolveRosterIcon falls through an unmapped class to the next character by CP", (t) => {
  mapEmoji(t, { Artist: "<:artist:1>", Bard: "<:bard:2>", Slayer: "" });
  const icon = resolveRosterIcon("Qiylyn", [
    { name: "Qiylyn", className: "Slayer", combatScore: "5000" },
    { name: "Bardly", className: "Bard", combatScore: "100" },
    { name: "Artly", className: "Artist", combatScore: "900" },
  ]);
  assert.equal(icon, "<:artist:1>");
});

test("resolveRosterIcon returns the question mark when nothing resolves", (t) => {
  mapEmoji(t, { Slayer: "" });
  assert.equal(resolveRosterIcon("Qiylyn", []), ROSTER_ICON_UNKNOWN);
  assert.equal(
    resolveRosterIcon("Qiylyn", [{ name: "Qiylyn", className: "Slayer", combatScore: "1" }]),
    "❓"
  );
});

test("countRoles splits support and dps", () => {
  assert.deepEqual(countRoles(["Bard", "Paladin", "Berserker"]), { supports: 2, dps: 1 });
});

test("chunkLinesIntoFields keeps every line whole under the limit", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `${String(index).padStart(2, "0")}`.padEnd(93, "x"));
  const fields = chunkLinesIntoFields(lines, "Character (20)");

  assert.ok(fields.length >= 2);
  for (const field of fields) {
    assert.ok(field.value.length <= 1024, `field over limit: ${field.value.length}`);
    assert.equal(field.inline, false);
  }
  assert.equal(fields[0].name, "Character (20)");
  assert.equal(fields[1].name, "​");
  assert.deepEqual(fields.flatMap((field) => field.value.split("\n")), lines);
});

test("chunkLinesIntoFields returns no field for no lines", () => {
  assert.deepEqual(chunkLinesIntoFields([], "Character (0)"), []);
});
