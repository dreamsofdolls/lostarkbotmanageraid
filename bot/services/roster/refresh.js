/**
 * services/roster/refresh.js
 * Stale-roster refresh service: pulls fresh iLvl/CP/class data from
 * lostark.bible for every account whose lastRefreshedAt is past the
 * cooldown window. Used by /raid-status piggyback, /raid-check pre-
 * render, and the /raid-share viewer-scoped paths.
 *
 * Invariants: refresh attempts NEVER block the user-facing render ·
 * stale data is rendered while a background refresh runs. HTTP 429
 * aborts the per-account seed loop immediately so a single rate-
 * limit window doesn't fan out to ~N more bible requests.
 */

const ROSTER_REFRESH_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const ROSTER_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const REFRESH_SEED_FAILURE_DETAIL_LIMIT = 3;

function getErrorMessage(err) {
  return err?.message || String(err || "unknown error");
}

function isRateLimitMessage(message) {
  return /\bHTTP 429\b/i.test(String(message || "")) ||
    /rate.?limit/i.test(String(message || ""));
}

/**
 * Build the roster-refresh service. Returns predicates for staleness
 * (`isAccountRefreshStale`, `hasStaleAccountRefreshes`), the cooldown-
 * remaining formatter, and the gather/apply pair callers wrap around
 * their own saveWithRetry loop.
 *
 * @param {object} deps - injected helpers
 * @param {Function} deps.normalizeName - lowercase + trim name normalizer
 * @param {Function} deps.foldName - NFKD diacritic-strip + lowercase
 * @param {Function} deps.getCharacterName - per-char name accessor
 *   (handles legacy `name` vs `charName` field divergence)
 * @param {Function} deps.formatNextCooldownRemaining - "Nm remaining"
 *   formatter shared with /raid-auto-manage cooldown UX
 * @param {Function} deps.buildFetchedRosterIndexes - index builder for
 *   the parsed bible roster (used by the apply phase)
 * @param {Function} deps.findFetchedRosterMatchForCharacter - resolves a
 *   saved character against the fresh bible parse (handles renames)
 * @param {Function} deps.fetchRosterCharacters - bible HTTP fetcher
 *   (wrapped in the global bibleLimiter at the compose root)
 * @returns {{
 *   isAccountRefreshStale: Function,
 *   hasStaleAccountRefreshes: Function,
 *   formatRosterRefreshCooldownRemaining: Function,
 *   collectStaleAccountRefreshes: Function,
 *   collectAccountRefresh: Function,
 *   applyStaleAccountRefreshes: Function,
 * }}
 */
function createRosterRefreshService(deps) {
  const {
    normalizeName,
    foldName,
    getCharacterName,
    formatNextCooldownRemaining,
    buildFetchedRosterIndexes,
    findFetchedRosterMatchForCharacter,
    fetchRosterCharacters,
  } = deps;
  const staleAccountRefreshInFlight = new Map();

  // One normalized count map replaces repeated cross-account scans. The apply
  // phase mutates the same representation after each accepted rename so later
  // collision decisions still observe the current roster state.
  function buildAccountNameCounts(accounts) {
    const counts = new Map();
    for (const account of accounts || []) {
      const name = normalizeName(account?.accountName);
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
    return counts;
  }

  function hasOtherAccountWithName(accountNameCounts, account, normalizedName) {
    if (!normalizedName) return false;
    const ownContribution = normalizeName(account?.accountName) === normalizedName ? 1 : 0;
    return (accountNameCounts.get(normalizedName) || 0) > ownContribution;
  }

  function moveAccountNameCount(accountNameCounts, previousName, nextName) {
    if (previousName === nextName) return;
    if (previousName) {
      const previousCount = accountNameCounts.get(previousName) || 0;
      if (previousCount <= 1) accountNameCounts.delete(previousName);
      else accountNameCounts.set(previousName, previousCount - 1);
    }
    if (nextName) {
      accountNameCounts.set(nextName, (accountNameCounts.get(nextName) || 0) + 1);
    }
  }

  // cooldownMs is parameterized so callers with a manager discordId can
  // pass `getRosterRefreshCooldownMs(discordId)` (10m for managers, 2h
  // for regulars). Default keeps the conservative 2h spacing for
  // ambient calls that don't have a viewer in scope.
  function isAccountRefreshStale(account, now = Date.now(), cooldownMs = ROSTER_REFRESH_COOLDOWN_MS) {
    const chars = Array.isArray(account?.characters) ? account.characters : [];
    if (chars.length === 0) return false;

    const lastSuccess = Number(account?.lastRefreshedAt) || 0;
    if ((now - lastSuccess) <= cooldownMs) return false;

    const lastAttempt = Number(account?.lastRefreshAttemptAt) || 0;
    if (lastAttempt > lastSuccess && (now - lastAttempt) < ROSTER_REFRESH_FAILURE_COOLDOWN_MS) {
      return false;
    }

    return true;
  }

  function hasStaleAccountRefreshes(userDoc, now = Date.now(), cooldownMs = ROSTER_REFRESH_COOLDOWN_MS) {
    const accounts = Array.isArray(userDoc?.accounts) ? userDoc.accounts : [];
    return accounts.some((account) => isAccountRefreshStale(account, now, cooldownMs));
  }

  function formatRosterRefreshCooldownRemaining(account, cooldownMs = ROSTER_REFRESH_COOLDOWN_MS) {
    const lastSuccess = Number(account?.lastRefreshedAt) || 0;
    const lastAttempt = Number(account?.lastRefreshAttemptAt) || 0;
    if (lastAttempt > lastSuccess) {
      const failureRemain = formatNextCooldownRemaining(
        lastAttempt,
        ROSTER_REFRESH_FAILURE_COOLDOWN_MS
      );
      if (failureRemain) return failureRemain;
    }
    return formatNextCooldownRemaining(lastSuccess, cooldownMs);
  }

  function buildRefreshInFlightKey(userDoc, account) {
    const discordId = String(userDoc?.discordId || "").trim();
    const accountName = normalizeName(account?.accountName);
    if (!discordId || !accountName) return null;
    return `${discordId}:${accountName}`;
  }

  function findAccountByName(userDoc, accountName) {
    const target = normalizeName(accountName);
    if (!target || !Array.isArray(userDoc?.accounts)) return null;
    return userDoc.accounts.find((account) => normalizeName(account?.accountName) === target) || null;
  }

  function buildRefreshSearchState(account) {
    const seeds = [];
    const seenSeedNames = new Set();
    const savedNames = new Set();
    const savedFoldedNames = new Set();

    function addSeed(name) {
      const queryName = String(name || "").trim().normalize("NFC");
      const normalizedName = normalizeName(queryName);
      if (normalizedName && !seenSeedNames.has(normalizedName)) {
        seenSeedNames.add(normalizedName);
        seeds.push(queryName);
      }
      return normalizedName;
    }

    addSeed(account?.accountName);
    for (const character of account?.characters || []) {
      const name = getCharacterName(character);
      const normalizedName = addSeed(name);
      if (normalizedName) savedNames.add(normalizedName);
      const foldedName = foldName(name);
      if (foldedName) savedFoldedNames.add(foldedName);
    }

    return { seeds, savedNames, savedFoldedNames };
  }

  async function collectOneStaleAccountRefresh(account, accountNameCounts) {
    const originalName = account.accountName;
    // Preserve account-first retry order while sharing the same normalized
    // identity used by account lookup. This prevents case/whitespace variants
    // of one character from consuming separate Bible requests. Saved-name
    // overlap indexes are built in the same character pass.
    const { seeds, savedNames, savedFoldedNames } = buildRefreshSearchState(account);
    if (seeds.length === 0) {
      return {
        accountName: originalName,
        fetchedChars: null,
        resolvedSeed: null,
        attempted: false,
      };
    }

    let attempted = false;
    let zeroOverlapCount = 0;
    let rateLimitedAbort = false;
    const seedFailures = [];
    for (const seed of seeds) {
      try {
        attempted = true;
        const fetched = await fetchRosterCharacters(seed);
        if (!Array.isArray(fetched) || fetched.length === 0) continue;

        const hasOverlap = fetched.some((c) =>
          savedNames.has(normalizeName(c.charName)) ||
          savedFoldedNames.has(foldName(c.charName))
        );
        if (!hasOverlap) {
          zeroOverlapCount += 1;
          continue;
        }

        let resolvedSeed = null;
        if (originalName !== seed) {
          const normalizedSeed = normalizeName(seed);
          const collides = hasOtherAccountWithName(
            accountNameCounts,
            account,
            normalizedSeed
          );
          if (!collides) resolvedSeed = seed;
        }

        return { accountName: originalName, fetchedChars: fetched, resolvedSeed, attempted };
      } catch (err) {
        const message = getErrorMessage(err);
        seedFailures.push({ seed, message });
        // Bible is rate-limiting THIS host right now. Every remaining
        // seed of this account would hit the same backoff window with no
        // chance of succeeding, so stop here and let the 5-min failure
        // cooldown gate the retry. Without this guard a single rate-
        // limit window burns ~N seeds per account and a thundering-herd
        // of refresh-eligible accounts amplifies the load on bible just
        // when its limiter is trying to shed it.
        if (isRateLimitMessage(message)) {
          rateLimitedAbort = true;
          break;
        }
      }
    }

    if (zeroOverlapCount > 0) {
      console.warn(
        `[refresh] account "${originalName || "(unnamed roster)"}" skipped ${zeroOverlapCount} seed(s) with zero overlap - refresh not applied.`
      );
    }
    if (seedFailures.length > 0) {
      const rateLimited = seedFailures.filter((entry) => isRateLimitMessage(entry.message));
      const otherFailures = seedFailures.filter((entry) => !isRateLimitMessage(entry.message));
      if (rateLimitedAbort) {
        console.warn(
          `[refresh] account "${originalName || "(unnamed roster)"}" aborted on first LostArk Bible HTTP 429 - retry after the failure cooldown.`
        );
      } else if (rateLimited.length > 0) {
        console.warn(
          `[refresh] account "${originalName || "(unnamed roster)"}" ${rateLimited.length} seed(s) hit LostArk Bible HTTP 429 - suppressed per-seed logs.`
        );
      }
      for (const entry of otherFailures.slice(0, REFRESH_SEED_FAILURE_DETAIL_LIMIT)) {
        console.warn(`[refresh] seed "${entry.seed}" failed: ${entry.message}`);
      }
      if (otherFailures.length > REFRESH_SEED_FAILURE_DETAIL_LIMIT) {
        console.warn(
          `[refresh] account "${originalName || "(unnamed roster)"}" ${otherFailures.length - REFRESH_SEED_FAILURE_DETAIL_LIMIT} additional seed failure(s) suppressed.`
        );
      }
    }

    return { accountName: originalName, fetchedChars: null, resolvedSeed: null, attempted };
  }

  function collectOneStaleAccountRefreshDeduped(userDoc, account, accountNameCounts) {
    const key = buildRefreshInFlightKey(userDoc, account);
    if (!key) return collectOneStaleAccountRefresh(account, accountNameCounts);

    if (!staleAccountRefreshInFlight.has(key)) {
      const promise = collectOneStaleAccountRefresh(account, accountNameCounts)
        .finally(() => staleAccountRefreshInFlight.delete(key));
      staleAccountRefreshInFlight.set(key, promise);
    }
    return staleAccountRefreshInFlight.get(key);
  }

  async function collectStaleAccountRefreshes(userDoc) {
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      return [];
    }

    const now = Date.now();
    const staleAccounts = userDoc.accounts.filter((account) => isAccountRefreshStale(account, now));
    if (staleAccounts.length === 0) return [];

    const accountNameCounts = buildAccountNameCounts(userDoc.accounts);

    const results = await Promise.allSettled(
      staleAccounts.map((account) =>
        collectOneStaleAccountRefreshDeduped(userDoc, account, accountNameCounts)
      )
    );

    const collected = [];
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(`[refresh] account fetch failed: ${result.reason?.message || result.reason}`);
        continue;
      }
      collected.push(result.value);
    }
    return collected;
  }

  async function collectAccountRefresh(userDoc, accountName) {
    const originalName = String(accountName || "").trim();
    const account = findAccountByName(userDoc, originalName);
    if (!account) {
      return {
        accountName: originalName,
        fetchedChars: null,
        resolvedSeed: null,
        attempted: false,
        missing: true,
      };
    }

    const accountNameCounts = buildAccountNameCounts(userDoc.accounts);
    return collectOneStaleAccountRefreshDeduped(userDoc, account, accountNameCounts);
  }

  function applyStaleAccountRefreshes(userDoc, collected) {
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      return false;
    }
    if (!Array.isArray(collected) || collected.length === 0) return false;

    const byName = new Map(
      collected
        .filter((entry) => entry?.accountName)
        .map((entry) => [normalizeName(entry.accountName), entry])
    );

    let didUpdate = false;
    const now = Date.now();
    // Renames are applied sequentially, so keep the counts in sync after each
    // accepted rename to preserve the former fresh-array collision semantics.
    const accountNameCounts = buildAccountNameCounts(userDoc.accounts);

    for (const account of userDoc.accounts) {
      const entry = byName.get(normalizeName(account?.accountName));
      if (!entry || !entry.attempted) continue;

      account.lastRefreshAttemptAt = now;
      didUpdate = true;

      const fetched = entry.fetchedChars;
      if (!Array.isArray(fetched) || fetched.length === 0) continue;

      const fetchedIndexes = buildFetchedRosterIndexes(fetched);
      let matchedAny = false;
      for (const character of account.characters || []) {
        const matchInfo = findFetchedRosterMatchForCharacter(character, fetchedIndexes);
        if (!matchInfo) continue;

        const match = matchInfo.match;
        matchedAny = true;
        const currentName = getCharacterName(character);
        if (match.charName && currentName !== match.charName) {
          character.name = match.charName;
          character.bibleSerial = null;
          character.bibleCid = null;
          character.bibleRid = null;
        }
        character.itemLevel = Number(match.itemLevel) || character.itemLevel;
        character.combatScore = String(match.combatScore || character.combatScore || "");
        if (match.className) character.class = match.className;
      }

      if (!matchedAny) {
        console.warn(
          `[refresh] account "${account.accountName}" fetched ${fetched.length} chars but zero overlap with saved roster - skipping success stamp.`
        );
        continue;
      }

      if (entry.resolvedSeed && account.accountName !== entry.resolvedSeed) {
        const normalizedSeed = normalizeName(entry.resolvedSeed);
        const freshCollides = hasOtherAccountWithName(
          accountNameCounts,
          account,
          normalizedSeed
        );
        if (!freshCollides) {
          const previousName = normalizeName(account.accountName);
          account.accountName = entry.resolvedSeed;
          moveAccountNameCount(accountNameCounts, previousName, normalizedSeed);
        }
      }

      account.lastRefreshedAt = now;
    }

    return didUpdate;
  }

  return {
    isAccountRefreshStale,
    hasStaleAccountRefreshes,
    formatRosterRefreshCooldownRemaining,
    collectStaleAccountRefreshes,
    collectAccountRefresh,
    applyStaleAccountRefreshes,
  };
}

module.exports = {
  createRosterRefreshService,
  ROSTER_REFRESH_COOLDOWN_MS,
  ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
};
