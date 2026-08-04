/**
 * test/locale-invariants.test.js
 * Machine-checkable guards for the Artist voice pass. Discipline across ~1500
 * keys x 3 locales leaks; these assertions are what keeps it honest.
 *
 * Deliberately NOT gated here: the count of "Đã " openers. Uniformity is the
 * defect, not the word - a numeric threshold would force awkward phrasing.
 * That one stays human-judged in review.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { TRANSLATIONS } = require("../bot/locales");

const LANGS = ["vi", "en", "jp"];
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

// Japanese has no plural marker, so these two keys legitimately drop {plural}.
// Any OTHER placeholder-set divergence is a bug.
const PLACEHOLDER_EXCEPTIONS = new Set([
  "raid-remove-roster.removedRoster.withChars",
  "raid-remove-roster.removedChar.remaining",
]);

/**
 * Flatten a locale tree to dotted key -> leaf value. Arrays and {variants}
 * pools are leaves: their members are inspected by the checks below rather
 * than being flattened into separate keys.
 * @param {unknown} node
 * @param {string} prefix
 * @param {Map<string, unknown>} out
 * @returns {Map<string, unknown>}
 */
function flatten(node, prefix, out) {
  if (node == null) return out;
  if (typeof node === "string" || Array.isArray(node)) {
    out.set(prefix, node);
    return out;
  }
  if (typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

const MAPS = Object.fromEntries(
  LANGS.map((lang) => [lang, flatten(TRANSLATIONS[lang], "", new Map())]),
);

/** Every string a leaf contributes, whether plain, multi-line block, or pool. */
function membersOf(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  return [];
}

function tokensOf(value) {
  return new Set(
    membersOf(value).flatMap((s) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1])),
  );
}

test("locale key sets are identical across vi/en/jp", () => {
  const base = [...MAPS.vi.keys()].sort();
  for (const lang of ["en", "jp"]) {
    const missing = base.filter((k) => !MAPS[lang].has(k));
    const extra = [...MAPS[lang].keys()].filter((k) => !MAPS.vi.has(k));
    assert.deepEqual(missing, [], `${lang} is missing keys`);
    assert.deepEqual(extra, [], `${lang} has keys vi does not`);
  }
});

test("each key carries the same placeholder SET in every locale", () => {
  // Set-based, not count-based: a locale may legitimately repeat a token.
  const offenders = [];
  for (const key of MAPS.vi.keys()) {
    if (PLACEHOLDER_EXCEPTIONS.has(key)) continue;
    const base = tokensOf(MAPS.vi.get(key));
    for (const lang of ["en", "jp"]) {
      if (!MAPS[lang].has(key)) continue;
      const other = tokensOf(MAPS[lang].get(key));
      const diff = [...base]
        .filter((tok) => !other.has(tok))
        .concat([...other].filter((tok) => !base.has(tok)));
      if (diff.length > 0) offenders.push(`${key} [vi vs ${lang}]: ${diff.join(", ")}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("variant pool members share their siblings' placeholder set", () => {
  // A pool member that drops {n} shows a literal {n} one time in N - that
  // reads as a flake rather than a bug, so it must be caught mechanically.
  const offenders = [];
  for (const lang of LANGS) {
    for (const [key, value] of MAPS[lang]) {
      if (!key.endsWith(".variants") || !Array.isArray(value)) continue;
      const sets = value.map(
        (member) => new Set([...String(member).matchAll(PLACEHOLDER)].map((m) => m[1])),
      );
      const [first, ...rest] = sets;
      rest.forEach((set, i) => {
        const diff = [...first]
          .filter((tok) => !set.has(tok))
          .concat([...set].filter((tok) => !first.has(tok)));
        if (diff.length > 0) {
          offenders.push(`${lang}:${key}[${i + 1}] differs by ${diff.join(", ")}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, []);
});

test("variant pools are non-empty arrays of strings", () => {
  const offenders = [];
  for (const lang of LANGS) {
    for (const [key, value] of MAPS[lang]) {
      if (!key.endsWith(".variants")) continue;
      if (!Array.isArray(value) || value.length === 0) {
        offenders.push(`${lang}:${key} is not a non-empty array`);
        continue;
      }
      if (value.some((member) => typeof member !== "string")) {
        offenders.push(`${lang}:${key} holds a non-string member`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("locale copy contains no em-dash", () => {
  // feedback_no_emdash: user-facing text uses a plain hyphen.
  const offenders = [];
  for (const lang of LANGS) {
    for (const [key, value] of MAPS[lang]) {
      if (membersOf(value).some((s) => s.includes("—"))) {
        offenders.push(`${lang}:${key}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("locale copy contains no italic stage directions", () => {
  // feedback_no_stage_directions: voice lives in word choice, not *vẫy đuôi*.
  // Bounded to short spans so markdown emphasis inside long prose is not
  // mistaken for a stage direction.
  const STAGE = /(^|\s)\*[^*`\n]{2,40}\*(\s|$|[.,!?~])/;
  const offenders = [];
  for (const lang of LANGS) {
    for (const [key, value] of MAPS[lang]) {
      if (membersOf(value).some((s) => STAGE.test(s))) offenders.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Warmth has to fit the moment. These keys are the cases where Artist herself
// failed or the user's work was lost - a save that did not persist, a picker
// session that expired, a sync that could not fetch, a permission refusal.
// A trailing "nha~" there reads as not taking it seriously.
//
// Deliberately NOT listed: ordinary input validation (an image that is too
// large, a missing option). Those are normal boundaries, not failures, and
// Artist being kind about them is correct rather than a defect.
const FAILURE_KEYS = [
  "raid-schedule.notice.showpickDeniedDescription",
  "raid-add-roster.expired.description",
  "raid-add-roster.expired.staleSessionDescription",
  "raid-add-roster.persistFail.description",
  "raid-edit-roster.expired.description",
  "raid-edit-roster.expired.staleSessionDescription",
  "raid-edit-roster.persistFail.description",
  "raid-gold-earner.expired.description",
  "raid-gold-earner.expired.staleSessionDescription",
  "raid-gold-earner.saveFail.description",
  "raid-status.piggyback.failed",
  "raid-status.sync.followupFailedDescription",
  "raidBg.errors.downloadFailed",
  "raidBg.errors.storageFailed",
];

test("failure copy carries no warmth marker", () => {
  // vi/en use "~"; jp uses "♪". The jp "～" is left alone on purpose - there it
  // is part of the ojou-sama register, not a cheerfulness signal.
  const MARKERS = { vi: /~/, en: /~/, jp: /♪/ };
  const offenders = [];
  for (const lang of LANGS) {
    for (const key of FAILURE_KEYS) {
      const value = MAPS[lang].get(key);
      if (!value) {
        offenders.push(`${lang}:${key} is missing`);
        continue;
      }
      if (membersOf(value).some((s) => MARKERS[lang].test(s))) offenders.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(offenders, []);
});
