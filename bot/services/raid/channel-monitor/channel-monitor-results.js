"use strict";

const { t: translate } = require("../../i18n");
const {
  buildAccessibleCharacterIndex,
  formatNamedCharacter,
  toCharacterLookupKey,
} = require("./channel-monitor-characters");

function summarizeRaidChannelResults(results) {
  const list = Array.isArray(results) ? results : [];
  const notFoundResults = list.filter((r) => !r.matched && !r.error);
  const alreadyResults = list.filter(
    (r) => r.matched && !r.updated && (r.alreadyComplete || r.alreadyReset)
  );
  const ineligibleResults = list.filter(
    (r) => r.matched && !r.updated && !r.alreadyComplete && !r.alreadyReset
  );
  const errorResults = list.filter((r) => r.error);
  const successCount = list.filter((r) => r.updated).length;
  const alreadyCount = alreadyResults.length;

  return {
    hadNoRoster: list.some((r) => r.noRoster),
    successCount,
    alreadyCount,
    notFoundResults,
    ineligibleResults,
    errorResults,
    hasProgress: successCount > 0 || alreadyCount > 0,
    hasErrors:
      notFoundResults.length > 0 ||
      ineligibleResults.length > 0 ||
      errorResults.length > 0,
  };
}

/**
 * Raid labels per character, in the order the post named them; a character
 * typed twice gets each raid once.
 * @param {Array<object>} resultGroups - one entry per raid of the post
 * @param {(result: object) => boolean} predicate - which results to keep
 * @returns {Map<string, {name: string, labels: string[]}>}
 */
function labelsByCharacter(resultGroups, predicate) {
  const byKey = new Map();
  for (const group of resultGroups) {
    for (const result of group.results) {
      if (!predicate(result)) continue;
      // A failed write has no displayName, only the name as typed.
      const name = result.displayName || result.charName;
      const key = toCharacterLookupKey(name);
      const entry = byKey.get(key) || { name, labels: [] };
      if (!entry.labels.includes(group.raidMeta.label)) entry.labels.push(group.raidMeta.label);
      byKey.set(key, entry);
    }
  }
  return byKey;
}

function formatEntries(index, byCharacter) {
  return [...byCharacter.values()]
    .map(({ name, labels }) => `${formatNamedCharacter(index, name)} \u00b7 ${labels.join(", ")}`)
    .join("; ");
}

/**
 * The channel hint for every failed character of a post, one note at the end.
 * @param {object} params
 * @param {Array<object>} params.resultGroups - one entry per raid of the post
 * @param {Array<object>} params.accounts - accessible accounts, for class icons
 * @param {string} params.authorLang
 * @param {object} params.UI
 * @param {Function} [params.t]
 * @returns {string|null} null when nothing failed
 */
function buildRaidChannelErrorHint({ resultGroups, accounts, authorLang, UI, t = translate }) {
  const summary = summarizeRaidChannelResults(resultGroups.flatMap((group) => group.results));
  if (!summary.hasErrors) return null;

  const index = buildAccessibleCharacterIndex(accounts);
  const lines = [];
  const notFoundNames = [...new Set(summary.notFoundResults.map((r) => r.charName))];
  if (notFoundNames.length > 0) {
    lines.push(t("text-parser.errorNotFound", authorLang, {
      icon: UI.icons.warn,
      names: notFoundNames.map((name) => `\`${name}\``).join(", "),
    }));
  }

  const ineligible = new Map();
  for (const group of resultGroups) {
    for (const r of group.results) {
      if (!summary.ineligibleResults.includes(r)) continue;
      const name = r.displayName || r.charName;
      const key = toCharacterLookupKey(name);
      const entry = ineligible.get(key) || { name, itemLevel: r.ineligibleItemLevel, raids: [] };
      const raid = t("text-parser.errorIneligibleRaid", authorLang, {
        raidLabel: group.raidMeta.label,
        minItemLevel: group.raidMeta.minItemLevel,
      });
      if (!entry.raids.includes(raid)) entry.raids.push(raid);
      ineligible.set(key, entry);
    }
  }
  for (const { name, itemLevel, raids } of ineligible.values()) {
    lines.push(t("text-parser.errorIneligibleCharacter", authorLang, {
      icon: UI.icons.warn,
      character: formatNamedCharacter(index, name),
      itemLevel,
      raids: raids.join(", "),
    }));
  }

  const failed = labelsByCharacter(resultGroups, (r) => Boolean(r.error));
  if (failed.size > 0) {
    // errorSystem keeps {names}: the preflight lookup failure also uses it.
    lines.push(t("text-parser.errorSystem", authorLang, {
      icon: UI.icons.warn,
      names: formatEntries(index, failed),
    }));
  }

  lines.push(t(summary.hasProgress ? "text-parser.errorPartialNote" : "text-parser.errorRetryNote", authorLang));
  return lines.join("\n");
}

/**
 * The channel message sent in place of the receipt DM when the author's DMs
 * are closed: every raid of the post in one message.
 * @param {object} params
 * @param {Array<object>} params.resultGroups - one entry per raid of the post
 * @param {Array<object>} params.accounts - accessible accounts, for class icons
 * @param {string} params.authorLang
 * @param {object} params.UI
 * @param {string} params.userId - the author, mentioned at the start
 * @param {Function} [params.t]
 * @returns {string}
 */
function buildRaidChannelDmFallbackText({ resultGroups, accounts, authorLang, UI, userId, t = translate }) {
  // One post is either a reset or a clear, never both.
  const isReset = resultGroups[0].statusType === "reset";
  const index = buildAccessibleCharacterIndex(accounts);
  const written = labelsByCharacter(resultGroups, (r) => Boolean(r.updated));
  const already = labelsByCharacter(
    resultGroups,
    (r) => !r.updated && Boolean(isReset ? r.alreadyReset : r.alreadyComplete)
  );
  // A character typed twice finds the raid already DONE on its second write;
  // this post wrote that raid, so it reads as written only.
  for (const [key, entry] of already) {
    entry.labels = entry.labels.filter((label) => !written.get(key)?.labels.includes(label));
    if (entry.labels.length === 0) already.delete(key);
  }
  const parts = [
    written.size > 0 && t(isReset ? "text-parser.dmFallbackReset" : "text-parser.dmFallbackWritten", authorLang, {
      entries: formatEntries(index, written),
    }),
    already.size > 0 && t(isReset ? "text-parser.dmFallbackAlreadyReset" : "text-parser.dmFallbackAlready", authorLang, {
      entries: formatEntries(index, already),
    }),
  ].filter(Boolean);

  const icon = written.size === 0 ? UI.icons.info : isReset ? UI.icons.reset : UI.icons.done;
  return t("text-parser.dmFallback", authorLang, {
    icon,
    userId,
    parts: parts.join(t("text-parser.dmFallbackSeparator", authorLang)),
  });
}

module.exports = {
  buildRaidChannelDmFallbackText,
  buildRaidChannelErrorHint,
  summarizeRaidChannelResults,
};
