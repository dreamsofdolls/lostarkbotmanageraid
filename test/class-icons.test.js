"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CLASS_NAMES, CLASS_EMOJI_MAP, getClassEmoji } = require("../bot/models/Class");

const ICONS_DIR = path.join(__dirname, "..", "assets", "class-icons");

// The emoji bootstrap skips a PNG whose name is not a CLASS_NAMES key, so a
// new class icon without its entry never reaches Discord.
test("every class icon names a known bible class with a seeded emoji slot", () => {
  const ids = fs.readdirSync(ICONS_DIR).filter(name => name.endsWith(".png")).map(name => name.slice(0, -".png".length));
  assert.deepEqual(ids.filter(id => !Object.hasOwn(CLASS_NAMES, id)), []);
  assert.deepEqual([...new Set(Object.values(CLASS_NAMES))].filter(name => !Object.hasOwn(CLASS_EMOJI_MAP, name)), []);
});

test("emoji lookup accepts Bible name spacing and case while using the current registered emoji", t => {
  const previous = CLASS_EMOJI_MAP['Shadow Hunter'];
  t.after(() => { CLASS_EMOJI_MAP['Shadow Hunter'] = previous; });
  CLASS_EMOJI_MAP['Shadow Hunter'] = '<:demonic:123456789012345678>';
  for (const name of ['Shadowhunter', 'Shadow Hunter', ' shadowhunter ', 'SHADOW HUNTER']) {
    assert.equal(getClassEmoji(name), CLASS_EMOJI_MAP['Shadow Hunter']);
  }
  CLASS_EMOJI_MAP['Shadow Hunter'] = '<:demonic_new:223456789012345678>';
  assert.equal(getClassEmoji('Shadowhunter'), CLASS_EMOJI_MAP['Shadow Hunter']);
  CLASS_EMOJI_MAP['Shadow Hunter'] = '';
  assert.equal(getClassEmoji('Shadowhunter'), '');
  for (const name of [undefined, '', 'Unknown', 'toString', '__proto__']) assert.equal(getClassEmoji(name), '');
});
