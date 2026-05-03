// Regression: welcome embed must not exceed Discord's 1024-char-per-field
// cap. Live deploy on 2026-04-27 hit `s.string().lengthLessThanOrEqual()`
// at addFields() because the maintenance bullet pushed the
// "📣 Artist sẽ tự nói" field over 1024 chars. Test parses the source so
// it stays decoupled from the (large) factory wiring.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC_PATH = path.join(
  __dirname,
  "..",
  "bot",
  "services",
  "raid-channel-monitor.js"
);

function extractWelcomeFieldLengths() {
  const src = fs.readFileSync(SRC_PATH, "utf8");
  const startIdx = src.indexOf("function buildRaidChannelWelcomeEmbed");
  const endIdx = src.indexOf("return embed;", startIdx);
  const block = src.slice(startIdx, endIdx);
  const re =
    /name: "([^"]+)"[\s\S]*?value: (\[[\s\S]*?\]\.join\([^)]+\)|"[^"]+")/g;
  const out = [];
  let m;
  while ((m = re.exec(block)) !== null) {
    const name = m[1];
    const valExpr = m[2];
    let strLen = 0;
    if (valExpr.startsWith("[")) {
      const lines = valExpr.match(/"(?:[^"\\]|\\.)*"/g) || [];
      strLen = lines.map((l) => JSON.parse(l)).join("\n").length;
    } else {
      strLen = JSON.parse(valExpr).length;
    }
    out.push({ name, length: strLen });
  }
  return out;
}

test("REGRESSION: welcome embed: every field value <= 1024 chars (Discord cap)", () => {
  const fields = extractWelcomeFieldLengths();
  assert.ok(fields.length > 0, "expected to extract at least one field");
  for (const f of fields) {
    assert.ok(
      f.length <= 1024,
      `field "${f.name}" is ${f.length} chars (cap 1024). Split into multiple fields if it grows past the limit.`
    );
  }
});

test("welcome embed: total field-value length leaves headroom under 6000-char embed cap", () => {
  const fields = extractWelcomeFieldLengths();
  const totalValueChars = fields.reduce((sum, f) => sum + f.length, 0);
  const totalNameChars = fields.reduce((sum, f) => sum + f.name.length, 0);
  // Discord's hard cap is 6000 across title + description + every field
  // name/value combined. Title/description add ~400 chars. Stay under 5500
  // total to keep room for the icon emoji prefixes that resolve at runtime.
  assert.ok(
    totalValueChars + totalNameChars < 5500,
    `welcome embed total ${totalValueChars + totalNameChars} chars - approaching Discord 6000 cap`
  );
});
