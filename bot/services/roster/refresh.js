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

  async function collectOneStaleAccountRefresh(userDoc, account, otherAccountNames) {
    const originalName = account.accountName;
    const seeds = [];
    if (originalName) seeds.push(originalName);
    for (const c of account.characters || []) {
      const name = getCharacterName(c);
      if (name && !seeds.includes(name)) seeds.push(name);
    }
    if (seeds.length === 0) {
      return {
        accountName: originalName,
        fetchedChars: null,
        resolvedSeed: null,
        attempted: false,
      };
    }

    const savedNames = (account.characters || [])
      .map((c) => normalizeName(getCharacterName(c)))
      .filter(Boolean);
    const savedFoldedNames = (account.characters || [])
      .map((c) => foldName(getCharacterName(c)))
      .filter(Boolean);

    let attempted = false;
    let zeroOverlapCount = 0;
    const seedFailures = [];
    for (const seed of seeds) {
      try {
        attempted = true;
        const fetched = await fetchRosterCharacters(seed);
        if (!Array.isArray(fetched) || fetched.length === 0) continue;

        const fetchedNames = new Set(fetched.map((c) => normalizeName(c.charName)));
        const fetchedFoldedNames = new Set(fetched.map((c) => foldName(c.charName)));
        const hasOverlap =
          savedNames.some((n) => fetchedNames.has(n)) ||
          savedFoldedNames.some((n) => fetchedFoldedNames.has(n));
        if (!hasOverlap) {
          zeroOverlapCount += 1;
          continue;
        }

        let resolvedSeed = null;
        if (originalName !== seed) {
          const normalizedSeed = normalizeName(seed);
          const collides = otherAccountNames.some(
            (name, i) => userDoc.accounts[i] !== account && name === normalizedSeed
          );
          if (!collides) resolvedSeed = seed;
        }

        return { accountName: originalName, fetchedChars: fetched, resolvedSeed, attempted };
      } catch (err) {
        seedFailures.push({ seed, message: getErrorMessage(err) });
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
      if (rateLimited.length > 0) {
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

  function collectOneStaleAccountRefreshDeduped(userDoc, account, otherAccountNames) {
    const key = buildRefreshInFlightKey(userDoc, account);
    if (!key) return collectOneStaleAccountRefresh(userDoc, account, otherAccountNames);

    if (!staleAccountRefreshInFlight.has(key)) {
      const promise = collectOneStaleAccountRefresh(userDoc, account, otherAccountNames)
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

    const otherAccountNames = userDoc.accounts.map((a) => normalizeName(a?.accountName));

    const results = await Promise.allSettled(
      staleAccounts.map((account) =>
        collectOneStaleAccountRefreshDeduped(userDoc, account, otherAccountNames)
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
        const freshCollides = userDoc.accounts.some(
          (other) => other !== account && normalizeName(other.accountName) === normalizedSeed
        );
        if (!freshCollides) account.accountName = entry.resolvedSeed;
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
    applyStaleAccountRefreshes,
  };
}

module.exports = {
  createRosterRefreshService,
  ROSTER_REFRESH_COOLDOWN_MS,
  ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
};
