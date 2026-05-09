const test = require("node:test");
const assert = require("node:assert/strict");

const { TRANSLATIONS, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require("../bot/locales");
const { normalizeLanguage, resolveLocale } = require("../bot/services/i18n");

function leafKeys(value, prefix = "", out = []) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      leafKeys(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.push(prefix);
  return out;
}

function flattenStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) flattenStrings(child, out);
  }
  return out;
}

test("first-class languages round-trip through normalizeLanguage", () => {
  const codes = SUPPORTED_LANGUAGES.map((entry) => entry.code);
  assert.deepEqual(codes, ["vi", "jp", "en"]);

  for (const code of codes) {
    assert.equal(normalizeLanguage(code), code);
    assert.equal(resolveLocale(code), code);
  }
  assert.equal(normalizeLanguage("fr"), DEFAULT_LANGUAGE);
  assert.equal(resolveLocale("fr"), DEFAULT_LANGUAGE);
});

test("locale packs keep the same leaf-key shape as vi", () => {
  const expected = new Set(leafKeys(TRANSLATIONS.vi));
  for (const [code, tree] of Object.entries(TRANSLATIONS)) {
    const actual = new Set(leafKeys(tree));
    const missing = [...expected].filter((key) => !actual.has(key));
    assert.deepEqual(missing, [], `${code} is missing locale keys`);
  }
});

test("jp/en raid-channel schedule copy matches per-language quiet hours", () => {
  const enText = flattenStrings(TRANSLATIONS.en).join("\n");
  assert.match(enText, /03:00-08:00 UTC/);
  assert.match(enText, /03:00 UTC bedtime/);
  assert.match(enText, /08:00 UTC wakeup/);
  assert.doesNotMatch(enText, /01:00-20:00|20:00-01:00|20:00 UTC bedtime|01:00 UTC wakeup/);

  const jpText = flattenStrings(TRANSLATIONS.jp).join("\n");
  assert.match(jpText, /朝3時/);
  assert.match(jpText, /朝8時/);
  assert.doesNotMatch(jpText, /朝5時|朝10時|翌5時/);
});
