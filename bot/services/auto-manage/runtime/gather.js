"use strict";

const {
  AUTO_MANAGE_GATHER_CHARACTER_CONCURRENCY,
  PUBLIC_LOG_DISABLED_REPROBE_MS,
} = require("./constants");
const {
  filterLogsForCharacter,
  mapWithConcurrency,
} = require("./helpers");

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
  async function resolveBibleCharacterMetaViaRoster(account, character, rosterFetchCache = null) {
    const seeds = [];
    if (account?.accountName) seeds.push(account.accountName);
    for (const c of account?.characters || []) {
      const name = getCharacterName(c);
      if (name && !seeds.includes(name)) seeds.push(name);
    }

    for (const seed of seeds) {
      let fetched;
      const cacheKey = normalizeName(seed);
      if (rosterFetchCache) {
        if (!rosterFetchCache.has(cacheKey)) {
          rosterFetchCache.set(
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
        fetched = await rosterFetchCache.get(cacheKey);
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

      const matchInfo = findFetchedRosterMatchForCharacter(
        character,
        buildFetchedRosterIndexes(fetched)
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

  async function resolveBibleMetaForEntry(account, character, entry, rosterFetchCache) {
    try {
      const meta = await fetchBibleCharacterMetaWithLimiter(entry.charName);
      return { meta, canonicalName: null, source: "direct" };
    } catch (directErr) {
      const resolved = await resolveBibleCharacterMetaViaRoster(
        account,
        character,
        rosterFetchCache
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
    rosterFetchCache,
    weekResetStart,
  }) {
    const resolved = await resolveBibleMetaForEntry(account, character, entry, rosterFetchCache);
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

  async function gatherAutoManageLogsForCharacter(account, character, weekResetStart, rosterFetchCache) {
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
          rosterFetchCache
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
          rosterFetchCache,
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
      const rosterFetchCache = new Map();
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
        jobs.push({ account, character, rosterFetchCache });
      }
    }

    return mapWithConcurrency(
      jobs,
      AUTO_MANAGE_GATHER_CHARACTER_CONCURRENCY,
      ({ account, character, rosterFetchCache }) =>
        gatherAutoManageLogsForCharacter(account, character, weekResetStart, rosterFetchCache)
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
