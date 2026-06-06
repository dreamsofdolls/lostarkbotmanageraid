"use strict";

const {
  MAX_ACCOUNTS,
  MAX_BODY_BYTES,
  MAX_CHARACTERS_PER_ACCOUNT,
  PROFILE_VERSION,
} = require("./sanitizer/constants");
const {
  clampNumber,
  cleanShortString,
  normalizeKey,
} = require("./sanitizer/common");
const {
  cleanCharacterProfile,
} = require("./sanitizer/characters");
const {
  cleanProfileEncounterSummaries,
} = require("./sanitizer/encounters");
const {
  buildRosterIndexes,
  resolveRosterCharacter,
} = require("./sanitizer/roster");
const {
  hydrateAltBuildsFromEncounterSummaries,
} = require("./sanitizer/alt-build-hydrator");

function cleanSyncRange(payload) {
  const rawRange = payload.criteria?.range || {};
  const minFightStartMs = clampNumber(rawRange.minFightStartMs, { max: 9999999999999, fallback: null });
  return rawRange?.type === "weekly" && minFightStartMs > 0
    ? {
        type: "weekly",
        minFightStartMs,
      }
    : { type: "full" };
}

function cleanDbInfo(payload) {
  return {
    fileName: cleanShortString(payload.db?.fileName, 160),
    size: clampNumber(payload.db?.size, { max: 100 * 1024 * 1024 * 1024 }),
    lastModified: clampNumber(payload.db?.lastModified, { max: 9999999999999, fallback: null }),
  };
}

function collectAccounts(payload, indexes) {
  const accountsByName = new Map();
  let rejected = 0;

  for (const rawAccount of (Array.isArray(payload.accounts) ? payload.accounts : []).slice(0, MAX_ACCOUNTS)) {
    const rawAccountName = cleanShortString(rawAccount?.accountName, 80);
    if (!rawAccountName) continue;
    for (const rawChar of (Array.isArray(rawAccount?.characters) ? rawAccount.characters : []).slice(0, MAX_CHARACTERS_PER_ACCOUNT)) {
      const rosterEntry = resolveRosterCharacter(indexes, rawAccountName, rawChar?.name);
      if (!rosterEntry) {
        rejected += 1;
        continue;
      }
      const cleanChar = cleanCharacterProfile(rawChar, rosterEntry);
      if (!cleanChar) {
        rejected += 1;
        continue;
      }
      const accountName = rosterEntry.accountName || rawAccountName;
      if (!accountsByName.has(accountName)) {
        accountsByName.set(accountName, { accountName, characters: [] });
      }
      const bucket = accountsByName.get(accountName);
      if (!bucket.characters.some((c) => normalizeKey(c.name) === normalizeKey(cleanChar.name))) {
        bucket.characters.push(cleanChar);
      }
    }
  }

  const accounts = [...accountsByName.values()]
    .filter((account) => account.characters.length > 0)
    .sort((a, b) => a.accountName.localeCompare(b.accountName));

  return { accounts, rejected };
}

function summarizeAccounts(accounts) {
  let characterCount = 0;
  let encounterCount = 0;
  let firstFightStart = null;
  let lastFightStart = null;

  for (const account of accounts) {
    account.characters.sort((a, b) => a.name.localeCompare(b.name));
    characterCount += account.characters.length;
    for (const character of account.characters) {
      encounterCount += Number(character.stats?.encounters) || 0;
      const first = Number(character.stats?.firstFightStart) || 0;
      const last = Number(character.stats?.lastFightStart) || 0;
      if (first && (!firstFightStart || first < firstFightStart)) firstFightStart = first;
      if (last && (!lastFightStart || last > lastFightStart)) lastFightStart = last;
    }
  }

  return {
    characterCount,
    encounterCount,
    firstFightStart,
    lastFightStart,
  };
}

function sanitizeSnapshotPayload(payload, userDoc) {
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error("profile payload required"), { status: 400 });
  }

  const range = cleanSyncRange(payload);
  const indexes = buildRosterIndexes(userDoc);
  const { accounts, rejected } = collectAccounts(payload, indexes);
  const db = cleanDbInfo(payload);
  const encounterSummaries = cleanProfileEncounterSummaries(payload.encounters, indexes, range, db);
  hydrateAltBuildsFromEncounterSummaries(accounts, encounterSummaries);
  const accountSummary = summarizeAccounts(accounts);

  return {
    version: PROFILE_VERSION,
    source: "local",
    rangeType: range.type,
    generatedAt: clampNumber(payload.generatedAt, { max: 9999999999999, fallback: Date.now() }),
    receivedAt: Date.now(),
    criteria: {
      clearedOnly: true,
      supportedBossesOnly: true,
      minDurationMs: 180000,
      modernProfileStatsOnly: payload.criteria?.modernProfileStatsOnly !== false,
      source: "encounters.db",
      range,
    },
    db,
    totals: {
      accountCount: accounts.length,
      characterCount: accountSummary.characterCount,
      encounterCount: accountSummary.encounterCount,
      encounterSummaryCount: encounterSummaries.length,
      firstFightStart: accountSummary.firstFightStart,
      lastFightStart: accountSummary.lastFightStart,
      rejectedCharacters: rejected,
    },
    accounts,
    encounterSummaries,
  };
}

module.exports = {
  PROFILE_VERSION,
  MAX_BODY_BYTES,
  sanitizeSnapshotPayload,
};
