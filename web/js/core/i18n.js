// Minimal i18n resolver for the web companion. Reads active lang from
// window.__artistLang (set in app.js after token decode) and walks the
// dotted key path through the language dict. Mirror of the bot-side
// bot/services/i18n.js but ESM-shaped + no Mongo cache (no need - the
// page only renders one user's lang for one session).
//
// Variable interpolation supports `{name}` placeholders. Missing keys
// fall back to the default lang (vi), then to the raw key string so a
// missing translation never silently renders empty.

"use strict";

import { TRANSLATIONS, DEFAULT_LANG, SUPPORTED_LANGS } from "./locales.js";

export function normalizeLang(raw) {
  if (typeof raw !== "string") return DEFAULT_LANG;
  const lower = raw.toLowerCase().trim();
  if (SUPPORTED_LANGS.includes(lower)) return lower;
  // Discord locale code "ja" maps to the internal "jp" key. This also
  // handles tokens minted by Discord-locale-aware code paths.
  if (lower === "ja") return "jp";
  return DEFAULT_LANG;
}

function lookup(tree, dottedKey) {
  if (!tree || typeof tree !== "object") return null;
  let cursor = tree;
  for (const seg of dottedKey.split(".")) {
    if (cursor == null || typeof cursor !== "object") return null;
    cursor = cursor[seg];
  }
  return typeof cursor === "string" ? cursor : null;
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return String(vars[name]);
    }
    return match;
  });
}

function getActiveScope() {
  return window.__artistSyncScope === "solo" ? "solo" : "full";
}

function lookupForActiveScope(tree, key) {
  if (getActiveScope() === "solo") {
    const scopedValue = lookup(tree, `solo.${key}`);
    if (scopedValue != null) return scopedValue;
  }
  return lookup(tree, key);
}

export function getActiveLang() {
  return normalizeLang(window.__artistLang || DEFAULT_LANG);
}

export function setActiveLang(raw) {
  window.__artistLang = normalizeLang(raw);
  return window.__artistLang;
}

export function t(key, vars) {
  const lang = getActiveLang();
  const tree = TRANSLATIONS[lang] || TRANSLATIONS[DEFAULT_LANG];
  let value = lookupForActiveScope(tree, key);
  if (value == null && lang !== DEFAULT_LANG) {
    value = lookupForActiveScope(TRANSLATIONS[DEFAULT_LANG], key);
  }
  if (value == null) {
    // Last-resort fallback: surface the missing key so the dev sees it
    // in the rendered UI instead of an empty string. Console-warn once
    // per missing key so a typo isn't a silent bug.
    if (!seenMissingKeys.has(key)) {
      seenMissingKeys.add(key);
      console.warn(`[i18n] missing translation for key="${key}" lang="${lang}"`);
    }
    return key;
  }
  return interpolate(value, vars);
}

const seenMissingKeys = new Set();

// Locale-aware raid + mode label helpers. Used by preview-utils for the
// per-raid table headings. Falls back to the raidKey/modeKey itself if
// the lang dict is missing the entry.
export function getRaidLabel(raidKey) {
  const lang = getActiveLang();
  const labels = (TRANSLATIONS[lang] || TRANSLATIONS[DEFAULT_LANG]).raidLabels || {};
  return labels[raidKey] || raidKey;
}

export function getModeLabel(modeKey) {
  const lang = getActiveLang();
  const labels = (TRANSLATIONS[lang] || TRANSLATIONS[DEFAULT_LANG]).modeLabels || {};
  return labels[modeKey] || modeKey;
}

export function getRaidSpecificModeLabel(raidKey, modeKey) {
  const lang = getActiveLang();
  const tree = TRANSLATIONS[lang] || TRANSLATIONS[DEFAULT_LANG];
  const fallbackTree = TRANSLATIONS[DEFAULT_LANG] || {};
  const labels = tree.raidModeLabels?.[raidKey] || fallbackTree.raidModeLabels?.[raidKey] || {};
  return labels[modeKey] || getModeLabel(modeKey);
}

export function getRaidModeLabel(raidKey, modeKey) {
  const raid = getRaidLabel(raidKey);
  const mode = getRaidSpecificModeLabel(raidKey, modeKey);
  return mode ? `${raid} ${mode}` : raid;
}

/**
 * Apply translations to every element in the DOM that has a
 * `data-i18n="some.key"` attribute. Called once at boot after the
 * active lang is resolved from the token. Supports `data-i18n-attr`
 * to set an attribute (e.g. `placeholder`) instead of textContent.
 */
export function applyDomTranslations() {
  const elements = document.querySelectorAll("[data-i18n]");
  for (const el of elements) {
    const key = el.getAttribute("data-i18n");
    const targetAttr = el.getAttribute("data-i18n-attr");
    const text = t(key);
    if (targetAttr) {
      el.setAttribute(targetAttr, text);
    } else {
      el.textContent = text;
    }
  }
  // Also apply <title> so the browser tab matches.
  const titleKey = document.querySelector("title")?.getAttribute("data-i18n");
  if (titleKey) {
    document.title = t(titleKey);
  }
}
