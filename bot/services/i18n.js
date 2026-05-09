// i18n service for RaidManage. Three responsibilities:
//   1. Resolve translation strings via dot-notation key + variable interp.
//   2. Look up a viewer's preferred locale from their User doc, cached
//      in-process so /raid-status (which renders many strings per call)
//      doesn't re-query Mongo per t() invocation.
//   3. Persist a new locale + invalidate the cache atomically.
//
// Falls back: missing key in target locale → fall back to default
// locale (vi) → fall back to the raw key string. This keeps a typo'd
// key visible in dev output (you'll see "share.grant.foo" instead of
// "" or a thrown error) so it's easy to spot in QA.
"use strict";

const {
  TRANSLATIONS,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
} = require("../locales");

// First-class locales offered in /raid-language and persisted on User
// docs. Currently vi + jp.
const SUPPORTED_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));
// All locales that exist in TRANSLATIONS - includes partial locales
// like `en` which is only used by /raid-help's slash-option override.
// Used to validate t()'s lang argument so we can render `en` content
// without polluting the picker.
const KNOWN_LOCALE_CODES = new Set(Object.keys(TRANSLATIONS));

// In-process cache. Keyed by discordId, value = locale code. Cleared
// whenever setUserLanguage runs so a /raid-language change in this
// session reflects immediately. If the bot scales horizontally one day,
// this cache stays node-local; that's acceptable since stale entries
// only mean "1 view rendered in the previous language for ~one tick"
// after a switch on a sibling node.
const userLanguageCache = new Map();

/**
 * Coerce arbitrary input into a first-class locale code (vi or jp).
 * Used for persistence (user.language) and the /raid-language picker -
 * partial locales like `en` are NOT first-class and round-trip down to
 * the default. For t() rendering, see resolveLocale below.
 */
function normalizeLanguage(value) {
  const code = typeof value === "string" ? value.toLowerCase() : "";
  return SUPPORTED_CODES.has(code) ? code : DEFAULT_LANGUAGE;
}

/**
 * Coerce input into ANY known translation locale (vi, jp, en, ...).
 * Used by t() so a /raid-help language:en override can still render EN
 * content. Falls back to default if the code is unknown.
 */
function resolveLocale(value) {
  const code = typeof value === "string" ? value.toLowerCase() : "";
  return KNOWN_LOCALE_CODES.has(code) ? code : DEFAULT_LANGUAGE;
}

function getSupportedLanguages() {
  return SUPPORTED_LANGUAGES;
}

function lookupKey(tree, dottedKey) {
  if (!tree || typeof dottedKey !== "string") return undefined;
  const segments = dottedKey.split(".");
  let cursor = tree;
  for (const seg of segments) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = cursor[seg];
  }
  return cursor;
}

function applyVars(template, vars) {
  // Arrays (e.g. multi-line notes blocks) interpolate per element so a
  // single t() call can resolve a whole notes block in one shot.
  if (Array.isArray(template)) {
    return vars ? template.map((item) => applyVars(item, vars)) : template;
  }
  if (typeof template !== "string" || !vars) return template;
  // Simple {name} interpolation. Missing var leaves the literal {name}
  // in place so a missing var is visually obvious during dev.
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
  });
}

/**
 * Resolve a translation key.
 *
 *   t("raid-language.title", "jp") → "🌐 アーティストの言語を変更"
 *   t("share.grant.descriptionUpdate", "vi", {
 *     target: "123", previous: "view", permission: "edit",
 *   }) → "Đổi quyền cho <@123> từ `view` → `edit`. ..."
 *
 * Falls back to vi then to the raw key string.
 */
function t(key, lang = DEFAULT_LANGUAGE, vars = null) {
  // resolveLocale (not normalizeLanguage) so partial locales like `en`
  // can render their own keys without first being rewritten to vi.
  const code = resolveLocale(lang);
  const primary = lookupKey(TRANSLATIONS[code], key);
  if (primary != null) return applyVars(primary, vars);
  if (code !== DEFAULT_LANGUAGE) {
    const fallback = lookupKey(TRANSLATIONS[DEFAULT_LANGUAGE], key);
    if (fallback != null) return applyVars(fallback, vars);
  }
  return key;
}

/**
 * Cache-first lookup. Pass an optional UserModel for DI in tests; in
 * production the require() cycle would force a circular import if we
 * reached for the real model at module load, so callers pass it in.
 */
async function getUserLanguage(discordId, { UserModel } = {}) {
  if (!discordId) return DEFAULT_LANGUAGE;
  if (userLanguageCache.has(discordId)) return userLanguageCache.get(discordId);
  if (!UserModel) return DEFAULT_LANGUAGE;
  try {
    const doc = await UserModel.findOne({ discordId }, { language: 1 }).lean();
    const lang = normalizeLanguage(doc?.language);
    userLanguageCache.set(discordId, lang);
    return lang;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/**
 * Persist a new locale on the User doc and invalidate the cache. Upserts
 * because a user may pick a language before adding any roster (User doc
 * doesn't exist yet). Returns the resolved code.
 */
async function setUserLanguage(discordId, lang, { UserModel } = {}) {
  const code = normalizeLanguage(lang);
  if (!discordId) return code;
  if (UserModel) {
    await UserModel.updateOne(
      { discordId },
      { $set: { language: code } },
      { upsert: true },
    );
  }
  userLanguageCache.set(discordId, code);
  return code;
}

function clearUserLanguageCache() {
  userLanguageCache.clear();
}

module.exports = {
  t,
  getUserLanguage,
  setUserLanguage,
  clearUserLanguageCache,
  normalizeLanguage,
  resolveLocale,
  getSupportedLanguages,
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
};
