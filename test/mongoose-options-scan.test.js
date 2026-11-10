"use strict";

// mongoose 9 deprecates the `new` option of findOneAndUpdate and its
// relatives in favour of `returnDocument: "after"`, and warns on every call
// that still passes it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("no query passes the deprecated new option", () => {
  const hits = [];
  for (const file of listSourceFiles(path.join(ROOT, "bot"))) {
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (/\bnew:\s*true\b/.test(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
