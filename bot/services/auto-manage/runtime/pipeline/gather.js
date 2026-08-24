/**
 * Account-scoped Bible metadata and log gathering for auto-manage.
 *
 * Invariant: character jobs from one account share fallback seed order,
 * in-flight roster fetches, and derived roster indexes. Character log work
 * remains bounded by AUTO_MANAGE_GATHER_CHARACTER_CONCURRENCY.
 */

"use strict";

const {
  AUTO_MANAGE_GATHER_CHARACTER_CONCURRENCY,
  PUBLIC_LOG_DISABLED_REPROBE_MS,
} = require("../support/constants");
const {
  filterLogsForCharacter,
  mapWithConcurrency,
} = require("../support/helpers");

/**
 * Compose the auto-manage gather pipeline from its Bible and roster helpers.
 * @param {object} deps - injected runtime dependencies
 * @param {Function} deps.autoManageEntryKey - builds a stable account/character key
 * @param {Function} deps.buildFetchedRosterIndexes - indexes one fetched roster
 * @param {Function} deps.fetchBibleCharacterMetaWithLimiter - rate-limited metadata fetch
 * @param {Function} deps.fetchBibleLogsSinceWeekReset - weekly log fetch
 * @param {Function} deps.fetchRosterCharacters - roster fallback fetch
 * @param {Function} deps.findFetchedRosterMatchForCharacter - saved/fetched matcher
 * @param {Function} deps.getCharacterClass - saved character class accessor
 * @param {Function} deps.getCharacterName - saved character name accessor
 * @param {Function} deps.normalizeName - name normalizer
 * @param {Function} [deps.nowMs] - injectable clock for public-log reprobes
 * @returns {{
 *   gatherAutoManageLogsForCharacter: Function,
 *   gatherAutoManageLogsForUserDoc: Function,
 *   resolveBibleCharacterMetaViaRoster: Function,
 * }} gather operations
 */
function createAutoManageGatherer({
  autoManageEntryKey,
  buildFetchedRosterIndexes,
  fetchBibleCharacterMetaWithLimiter,
  fetchBibleLogsSinceWeekReset,
  fetchRosterCharacters,
  findFetchedRosterMatchForCharacter,
  getCharacterClass,
  getCharacterName,
  normalizeName,
  nowMs = () => Date.now(),
}) {
  function buildRosterFallbackSeeds(account) {
    const seeds = [];
    const seen = new Set();
    if (account?.accountName) {
      seeds.push(account.accountName);
      seen.add(account.accountName);
    }
    for (const c of account?.characters || []) {
      const name = getCharacterName(c);
      if (name && !seen.has(name)) {
        seeds.push(name);
        seen.add(name);
      }
    }
    return seeds;
  }

  function buildRosterFallbackContext(account) {
    // Separate caches share both the in-flight I/O promise and its derived CPU
    // index across concurrent character jobs without conflating the two values.
    return {
      seeds: buildRosterFallbackSeeds(account),
      fetchCache: new Map(),
      indexCache: new Map(),
    };
  }

  async function resolveBibleCharacterMetaViaRoster(
    account,
    character,
    rosterFallbackContext = null
  ) {
    // A raw Map is accepted for compatibility with older direct callers.
    const context = rosterFallbackContext instanceof Map
      ? { fetchCache: rosterFallbackContext }
      : rosterFallbackContext;
    const seeds = Array.isArray(context?.seeds)
      ? context.seeds
      : buildRosterFallbackSeeds(account);
    const fetchCache = context?.fetchCache || null;
    const indexCache = context?.indexCache || null;

    for (const seed of seeds) {
      let fetched;
      const cacheKey = normalizeName(seed);
      if (fetchCache) {
        if (!fetchCache.has(cacheKey)) {
          fetchCache.set(
            cacheKey,
            fetchRosterCharacters(seed).catch((err) => {
              console.warn(
                `[auto-manage] roster fallback seed "${seed}" failed:`,
                err?.message || err
              );
              return null;
            })
          );
        }
        fetched = await fetchCache.get(cacheKey);
      } else {
        try {
          fetched = await fetchRosterCharacters(seed);
        } catch (err) {
          console.warn(
            `[auto-manage] roster fallback seed "${seed}" failed:`,
            err?.message || err
          );
          continue;
        }
      }
      if (!Array.isArray(fetched) || fetched.length === 0) continue;

      let fetchedIndexes;
      if (indexCache) {
        if (!indexCache.has(cacheKey)) {
          indexCache.set(cacheKey, buildFetchedRosterIndexes(fetched));
        }
        fetchedIndexes = indexCache.get(cacheKey);
      } else {
        fetchedIndexes = buildFetchedRosterIndexes(fetched);
      }
      const matchInfo = findFetchedRosterMatchForCharacter(
        character,
        fetchedIndexes
      );
      const canonicalName = matchInfo?.match?.charName;
      if (!canonicalName) continue;

      let meta;
      try {
        meta = await fetchBibleCharacterMetaWithLimiter(canonicalName);
      } catch (err) {
        console.warn(
          `[auto-manage] roster fallback canonical meta for "${canonicalName}" failed:`,
          err?.message || err
        );
        continue;
      }
      return {
        canonicalName,
        meta,
        matchType: matchInfo.matchType,
        seed,
      };
    }

    return null;
  }

  async function resolveBibleMetaForEntry(account, character, entry, rosterFallbackContext) {
    try {
      const meta = await fetchBibleCharacterMetaWithLimiter(entry.charName);
      return { meta, canonicalName: null, source: "direct" };
    } catch (directErr) {
      const resolved = await resolveBibleCharacterMetaViaRoster(
        account,
        character,
        rosterFallbackContext
      );
      if (!resolved) throw directErr;
      return {
        meta: resolved.meta,
        canonicalName: resolved.canonicalName,
        source: `roster seed "${resolved.seed}" (${resolved.matchType} match)`,
      };
    }
  }

  async function refreshLogsForEntry({
    account,
    character,
    entry,
    rosterFallbackContext,
    weekResetStart,
  }) {
    const resolved = await resolveBibleMetaForEntry(
      account,
      character,
      entry,
      rosterFallbackContext
    );
    const meta = resolved.meta;
    entry.meta = { sn: meta.sn, cid: meta.cid, rid: meta.rid };
    if (resolved.canonicalName) entry.canonicalName = resolved.canonicalName;
    return fetchBibleLogsSinceWeekReset({
      serial: meta.sn,
      cid: meta.cid,
      rid: meta.rid,
      className: entry.className,
      weekResetStart,
    });
  }

  async function gatherAutoManageLogsForCharacter(
    account,
    character,
    weekResetStart,
    rosterFallbackContext
  ) {
    const charName = getCharacterName(character);
    const entry = {
      accountName: account.accountName,
      charName,
      entryKey: autoManageEntryKey(account.accountName, charName),
      className: getCharacterClass(character),
      meta: null,
      canonicalName: null,
      logs: null,
      error: null,
    };

    try {
      let serial = character.bibleSerial;
      let cid = character.bibleCid;
      let rid = character.bibleRid;
      if (!serial || !cid || !rid) {
        const resolved = await resolveBibleMetaForEntry(
          account,
          character,
          entry,
          rosterFallbackContext
        );
        if (resolved.canonicalName) {
          entry.canonicalName = resolved.canonicalName;
          console.warn(
            `[auto-manage] resolved bible meta for "${entry.charName}" via ${resolved.source} as "${resolved.canonicalName}".`
          );
        }
        const meta = resolved.meta;
        serial = meta.sn;
        cid = meta.cid;
        rid = meta.rid;
        entry.meta = { sn: serial, cid, rid };
      }

      entry.logs = await fetchBibleLogsSinceWeekReset({
        serial,
        cid,
        rid,
        className: entry.className,
        weekResetStart,
      });

      let filteredLogs = filterLogsForCharacter(
        entry.logs,
        entry.canonicalName || entry.charName,
        normalizeName
      );
      if (filteredLogs.mismatchedNames.length > 0 && filteredLogs.logs.length > 0) {
        console.warn(
          `[auto-manage] bible logs for "${entry.charName}" included other character(s): ${filteredLogs.mismatchedNames.join(", ")}; filtering them out.`
        );
      }
      if (
        filteredLogs.hadNamedLogs &&
        filteredLogs.logs.length === 0 &&
        filteredLogs.mismatchedNames.length > 0
      ) {
        console.warn(
          `[auto-manage] bible metadata for "${entry.charName}" returned only other character log(s): ${filteredLogs.mismatchedNames.join(", ")}; refreshing metadata.`
        );
        entry.logs = await refreshLogsForEntry({
          account,
          character,
          entry,
          rosterFallbackContext,
          weekResetStart,
        });
        filteredLogs = filterLogsForCharacter(
          entry.logs,
          entry.canonicalName || entry.charName,
          normalizeName
        );
        if (filteredLogs.mismatchedNames.length > 0 && filteredLogs.logs.length > 0) {
          console.warn(
            `[auto-manage] refreshed bible logs for "${entry.charName}" still included other character(s): ${filteredLogs.mismatchedNames.join(", ")}; filtering them out.`
          );
        }
      }
      entry.logs = filteredLogs.logs;
    } catch (err) {
      entry.error = err?.message || String(err);
      console.warn(
        `[auto-manage] gather for ${entry.charName} failed:`,
        err?.message || err
      );
    }
    return entry;
  }

  async function gatherAutoManageLogsForUserDoc(userDoc, weekResetStart, options = {}) {
    const includeEntryKeys = options?.includeEntryKeys
      ? new Set(options.includeEntryKeys)
      : null;
    const jobs = [];
    const now = nowMs();

    for (const account of userDoc.accounts || []) {
      // Context remains account-scoped so every job for this account shares
      // fallback work while independent accounts retain their own seed order.
      const rosterFallbackContext = buildRosterFallbackContext(account);
      for (const character of account.characters || []) {
        const entryKey = autoManageEntryKey(account.accountName, getCharacterName(character));
        if (includeEntryKeys && !includeEntryKeys.has(entryKey)) continue;

        const flaggedAt = character.publicLogDisabledAt
          ? new Date(character.publicLogDisabledAt).getTime()
          : 0;
        if (
          !includeEntryKeys &&
          character.publicLogDisabled &&
          flaggedAt > 0 &&
          now - flaggedAt < PUBLIC_LOG_DISABLED_REPROBE_MS
        ) {
          continue;
        }
        jobs.push({ account, character, rosterFallbackContext });
      }
    }

    return mapWithConcurrency(
      jobs,
      AUTO_MANAGE_GATHER_CHARACTER_CONCURRENCY,
      ({ account, character, rosterFallbackContext }) =>
        gatherAutoManageLogsForCharacter(
          account,
          character,
          weekResetStart,
          rosterFallbackContext
        )
    );
  }

  return {
    gatherAutoManageLogsForCharacter,
    gatherAutoManageLogsForUserDoc,
    resolveBibleCharacterMetaViaRoster,
  };
}

module.exports = {
  createAutoManageGatherer,
};
