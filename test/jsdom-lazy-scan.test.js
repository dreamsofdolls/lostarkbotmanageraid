"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BOT_DIR = path.resolve(__dirname, "../bot");
const NAMES_JSDOM = /['"]jsdom['"]/;

function walkBotJsFiles(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkBotJsFiles(full, rel));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(rel);
    }
  }
  return files.sort();
}

test("only the roster fetch service names jsdom", () => {
  const hits = walkBotJsFiles(BOT_DIR).filter((rel) =>
    NAMES_JSDOM.test(fs.readFileSync(path.join(BOT_DIR, rel), "utf8"))
  );
  assert.deepEqual(hits, ["services/roster/fetch.js"]);
});

test("requiring the roster fetch service leaves jsdom unloaded until HTML parsing runs", () => {
  const jsdomPath = require.resolve("jsdom");
  assert.equal(require.cache[jsdomPath], undefined);
  require("../bot/services/roster/fetch");
  assert.equal(require.cache[jsdomPath], undefined);
});
