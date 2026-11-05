/**
 * test/notice-locale-shape.test.js
 * Shape rules for notice copy. A tip is shown in the embed footer, where
 * Discord renders no markdown, so it carries no backtick and, as a short
 * next step, no closing period. A notice title carries no backtick either.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TRANSLATIONS } = require("../bot/locales");

const LANGS = ["vi", "en", "jp"];

// Dotted key -> list of strings; a {variants} pool contributes every member.
function flatten(node, prefix, out) {
  if (node == null) return out;
  if (typeof node === "string") return out.set(prefix, [node]);
  if (Array.isArray(node)) return out.set(prefix, node.filter((v) => typeof v === "string"));
  if (Array.isArray(node.variants)) return out.set(prefix, node.variants);
  if (typeof node === "object") {
    for (const [key, child] of Object.entries(node)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const MAPS = Object.fromEntries(LANGS.map((lang) => [lang, flatten(TRANSLATIONS[lang], "", new Map())]));

const isTipKey = (key) => /(Tip|\.tip)$/.test(key);
// A notice title is a `<stem>Title` whose stem also has a tip, or a
// `raid-log.notices.<code>.title`.
const isNoticeTitleKey = (key, map) =>
  (/Title$/.test(key) && map.has(key.replace(/Title$/, "Tip")))
  || /^raid-log\.notices\.[^.]+\.title$/.test(key);

function offenders(selectKey, isBad) {
  const out = [];
  for (const lang of LANGS) {
    for (const [key, values] of MAPS[lang]) {
      if (selectKey(key, MAPS[lang]) && values.some(isBad)) out.push(`${lang}:${key}`);
    }
  }
  return out;
}

test("tips carry no backtick and no closing period", () => {
  assert.deepEqual(offenders(isTipKey, (value) => /`/.test(value) || /[.。]$/.test(value.trim())), []);
});

test("notice titles carry no backtick", () => {
  assert.deepEqual(offenders(isNoticeTitleKey, (value) => /`/.test(value)), []);
});
