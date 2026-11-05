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
  "local-sync-discord.stateDescriptions.expired",
  "local-sync-discord.stateDescriptions.failed",
  "local-sync-discord.stateDescriptions.failedLocalOff",
  "local-sync-discord.stateDescriptions.failedBibleOff",
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
  "raid-status.goldView.shareRevokedDescription",
  "raid-status.goldView.nothingChangedDescription",
  "raid-status.goldView.saveFailedDescription",
  "raid-status.sync.buttonFailedDescription",
  "raid-status.sync.localNewLinkFailedDescription",
  "raid-status.sync.localRefreshFailedDescription",
  "raid-status.sync.followupFailedDescription",
  "raid-status.sync.rosterRefreshShareRevokedDescription",
  "raid-task.shareRevoked.title",
  "raid-task.shareRevoked.description",
  "raidBg.errors.downloadFailed",
  "raidBg.errors.storageFailed",
  "raid-log.notices.expired.description",
  "raid-log.notices.rate_limited.description",
  "raid-log.notices.timeout.description",
  "raid-log.notices.unavailable.description",
  "raid-log.notices.incomplete.description",
  "raid-log.notices.browser_crashed.description",
  "raid-log.notices.browser_unavailable.description",
  "raid-log.notices.character_mismatch.description",
  "raid-log.notices.invalid_view.description",
  "raid-log.notices.failed.description",
  "raid-log.recent.timedOut",
];

// The failure, guard and expired notices of the notice redesign. Each stem
// expands to its Title, Description and Tip where they exist; a stem without
// a Title stays in the list so the gate reports it missing.
const FAILURE_NOTICE_STEMS = [
  "raid-task.clear.confirmFailedCharacter",
  "raid-task.remove.noTask",
  "raid-task.sharedRemove.noTask",
  "raid-status.notice.staleCard",
  "raid-status.notice.shareLookupFailed",
  "raid-status.sync.noControl",
  "raid-status.sync.buttonFailed",
  "raid-status.sync.localReaderUnavailable",
  "raid-status.sync.localNewLinkFailed",
  "raid-status.sync.soloCompanionFailed",
  "raid-status.sync.localRefreshFailed",
  "raid-status.sync.rosterRefreshFailed",
  "raid-status.goldView.saveFailed",
  "raid-status.taskView.toggleFailed",
  "raid-auto-manage.mutex.bibleBlockedByLocal",
  "raid-auto-manage.mutex.localBlockedByBible",
  "raid-auto-manage.sync.localLocked",
  "raid-auto-manage.enable.probeFail",
  "raid-auto-manage.reset.fail",
  "raid-auto-manage.sync.fail",
  "raid-check.auth.managerOnly",
  "raid-check.auth.buttonManagerOnly",
  "raid-check.staleButton.unsupportedAction",
  "raid-check.notice.sessionLock",
  "raid-check.refreshFlow.missing",
  "raid-check.refreshFlow.failed",
  "raid-auto-manage.enableButton.expired",
  "raid-auto-manage.enableButton.flipFail",
  "raid-auto-manage.enableButton.userMissing",
  "raid-auto-manage.enableButton.localLocked",
  "raid-auto-manage.disableButton.expired",
  "raid-auto-manage.disableButton.flipFail",
  "raid-auto-manage.disableButton.userMissing",
  "raid-auto-manage.disableSelf.expired",
  "raid-auto-manage.disableSelf.notOwner",
  "raid-auto-manage.disableSelf.fail",
  "raid-auto-manage.disableSelf.accountMissing",
  "raid-auto-manage.enableSelf.expired",
  "raid-auto-manage.enableSelf.notOwner",
  "raid-auto-manage.enableSelf.fail",
  "raid-auto-manage.enableSelf.accountMissing",
  "raid-auto-manage.enableSelf.localLocked",
  "raid-channel.auth.serverOnly",
  "raid-channel.auth.manageGuild",
  "raid-channel.set.monitorDisabled",
  "raid-channel.set.missingPerms",
  "raid-channel.cleanup.channelGone",
  "raid-channel.cleanup.fail",
  "raid-announce.auth.serverOnly",
  "raid-announce.auth.manageGuild",
  "raid-announce.setChannel.missingPerms",
  "raid-set.roster.authLost",
  "share.auth.managerOnly",
  "share.unknownSubcommand",
  "raidBg.set.downloadFailed",
  "raidBg.set.saveFailed",
  "raid-add-roster.auth.managerOnly",
  "raid-add-roster.auth2.notYourPicker",
  "raid-add-roster.expired.staleSession",
  "raid-add-roster.duplicate.race",
  "raid-edit-roster.auth.notYourPicker",
  "raid-edit-roster.expired.staleSession",
  "raid-edit-roster.notice.gone",
  "raid-gold-earner.auth.notYourSession",
  "raid-gold-earner.expired.staleSession",
  "raid-gold-earner.notice.gone",
];

// /raid-log copy is `raid-log.notices.<code>.title|description|tip`.
const RAID_LOG_FAILURE_CODES = [
  "owner_only", "stale", "invalid_selection", "expired", "roster_changed", "logs_private",
  "character_mismatch", "unavailable", "incomplete", "browser_crashed", "browser_unavailable",
  "invalid_view", "failed", "revoked",
];

// Failure, guard and expired copy outside the <stem>Title shape: shared tips,
// shared save-failure sentences, share refusals and the timeout titles.
const FAILURE_NOTICE_KEYS = [
  "raid-task.save.addFailedTitle",
  "raid-task.save.failedTip",
  "raid-task.save.addFailedDescription",
  "raid-task.save.addAllFailedDescription",
  "raid-task.save.removeFailedDescription",
  "raid-task.save.sharedRemoveFailedDescription",
  "raid-task.save.sharedAddFailedDescription",
  "raid-task.save.clearFailedDescription",
  "raid-task.shareViewOnly.title",
  "raid-task.shareViewOnly.description",
  "raid-task.shareViewOnly.tip",
  "raid-task.shareRevoked.tip",
  "raid-status.goldView.shareViewOnlyDescription",
  "raid-status.sync.linkFailedTip",
  "raid-status.sync.rosterRefreshRetryTip",
  "local-sync-discord.notOwner",
  "local-sync-discord.notOwnerTitle",
  "local-sync-discord.notOwnerTip",
  "raid-auto-manage.enable.cancelTimeoutTitle",
  "raid-auto-manage.reset.cancelTimeoutTitle",
  "raid-check.auth.managerOnlyTip",
  "raid-check.staleButton.reopenTip",
  "raid-check.refreshFlow.retryTip",
  "raid-check.syncFlow.reportTitleFailed",
  "raid-check.syncFlow.reportHintAllFailed",
  "raid-add-roster.persistFail.title",
  "raid-add-roster.persistFail.tip",
  "raid-edit-roster.persistFail.title",
  "raid-edit-roster.persistFail.tip",
  "raid-gold-earner.saveFail.title",
  "raid-gold-earner.saveFail.tip",
];

// A variant pool flattens to `<key>.variants`.
const resolveKey = (key) =>
  MAPS.vi.has(key) || !MAPS.vi.has(`${key}.variants`) ? key : `${key}.variants`;

const expandStem = (stem) => {
  const title = resolveKey(`${stem}Title`);
  if (!MAPS.vi.has(title)) return [title];
  return ["Title", "Description", "Tip"]
    .map((part) => resolveKey(`${stem}${part}`))
    .filter((key) => MAPS.vi.has(key));
};

const WARMTH_GATED_KEYS = [...new Set([
  ...FAILURE_KEYS,
  ...FAILURE_NOTICE_KEYS.map(resolveKey),
  ...FAILURE_NOTICE_STEMS.flatMap(expandStem),
  ...RAID_LOG_FAILURE_CODES.flatMap((code) =>
    ["title", "description", "tip"].map((part) => `raid-log.notices.${code}.${part}`)),
])];

test("failure copy carries no warmth marker", () => {
  // vi/en use "~"; jp uses "♪". The jp "～" is left alone on purpose - there it
  // is part of the ojou-sama register, not a cheerfulness signal.
  const MARKERS = { vi: /~/, en: /~/, jp: /♪/ };
  const offenders = [];
  for (const lang of LANGS) {
    for (const key of WARMTH_GATED_KEYS) {
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
