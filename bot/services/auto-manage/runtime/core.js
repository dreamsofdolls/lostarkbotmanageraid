/**
 * services/auto-manage/runtime/core.js
 * Core auto-manage service: gather → reconcile → save flow that backs
 * every /raid-auto-manage entry point (the slash command, the scheduler
 * tick, the /raid-check Sync button, the /raid-status piggyback).
 *
 * Invariants: bible HTTP I/O lives in a gather phase OUTSIDE the
 * saveWithRetry loop so VersionError retries don't re-fire HTTP calls;
 * the apply phase is pure in-memory mutation. Public-log-off characters
 * are gated by a 24h reprobe window via `publicLogDisabledAt` (see
 * model + handlers/roster/edit.js carry-forward).
 */

"use strict";

const {
  DEFAULT_AUTO_MANAGE_SYNC_COOLDOWN_MS,
  getAutoManageCooldownMs: getAutoManageCooldownMsDefault,
} = require("../../access/manager");
const { createBibleClient } = require("../bible/client");
const {
  stampAutoManageAttemptFromReport,
  toPlainUserDoc,
  syncRaidProfileAfterAutoManageReport,
} = require("../reports/utils");
const { createAutoManageReportEmbeds } = require("../reports/embeds");
const {
  AUTO_MANAGE_GATHER_CHARACTER_CONCURRENCY,
  PUBLIC_LOG_DISABLED_REPROBE_MS,
} = require("./constants");
const {
  filterLogsForCharacter,
  mapWithConcurrency,
} = require("./helpers");
const {
  createAutoManageSyncSlotManager,
} = require("./slot");
const {
  createAutoManageReconciler,
} = require("./reconcile");

/**
 * Build the auto-manage core service. Returns a bag of handlers,
 * constants, and helper predicates that the rest of the bot wires
 * into slash commands, schedulers, and UI buttons.
 *
 * Factory shape mirrors every other RaidManage service: deps are
 * dependency-injected so unit tests can stub Discord builders,
 * Mongoose models, and the bible HTTP limiter without a live runtime.
 *
 * @param {object} deps - injected dependencies (see the destructure for
 *   the full list: discord.js EmbedBuilder + UI tokens, Mongoose User
 *   model + saveWithRetry, character/roster helpers, raid catalogue,
 *   bibleLimiter, and the per-user cooldown resolver).
 * @returns {object} service surface · see the `return {...}` literal at
 *   the bottom of the function for the canonical method/constant list
 *   (AUTO_MANAGE_SYNC_COOLDOWN_MS, gatherAutoManageLogsForUserDoc,
 *   applyAutoManageCollected, syncAutoManageForUserDoc,
 *   commitAutoManageOn, isPublicLogDisabledError, …).
 */
function createAutoManageCoreService({
  EmbedBuilder,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  toModeLabel,
  getCharacterName,
  getCharacterClass,
  fetchRosterCharacters,
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  getRaidGateForBoss,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  normalizeAssignedRaid,
  ensureAssignedRaids,
  bibleLimiter,
  syncRaidProfileFromBibleCollected = async () => null,
  // Injected so tests can stub per-user cooldown logic without touching env.
  // Falls back to the real manager.js helper (env-driven) in production.
  getAutoManageCooldownMs = getAutoManageCooldownMsDefault,
}) {
  // ---------------------------------------------------------------------------
  // /raid-auto-manage - lostark.bible clear-log sync
  // ---------------------------------------------------------------------------

  const {
    fetchBibleCharacterMetaWithLimiter,
    fetchBibleLogsSinceWeekReset,
  } = createBibleClient({ bibleLimiter });
  const {
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    formatAutoManageCooldownRemaining,
  } = createAutoManageSyncSlotManager({
    User,
    getAutoManageCooldownMs,
    defaultCooldownMs: DEFAULT_AUTO_MANAGE_SYNC_COOLDOWN_MS,
  });
  const {
    buildAutoManageHiddenCharsWarningEmbed,
    buildAutoManageSyncReportEmbed,
  } = createAutoManageReportEmbeds({ EmbedBuilder, UI });
  const {
    reconcileCharacterFromLogs,
  } = createAutoManageReconciler({
    ensureAssignedRaids,
    getRaidGateForBoss,
    RAID_REQUIREMENT_MAP,
    toModeLabel,
    normalizeName,
    normalizeAssignedRaid,
    getGatesForRaid,
  });

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

  /**
   * Build the identity key used to match a gathered entry back to its
   * character in the apply phase. Composite of normalized accountName +
   * normalized charName so two same-name chars across different rosters
   * (e.g. "Clauseduk" in roster A and a separate "Clauseduk" in roster B)
   * don't collide in the apply-side Map and swap logs. We can't rely on
   * `character.id` alone - backfill only runs through `/raid-set`, so users
   * who only use `/raid-auto-manage` or text posts may have chars with no
   * id yet. `\x1f` (ASCII Unit Separator) is a control char that cannot
   * appear in Lost Ark character names.
   */
  function autoManageEntryKey(accountName, charName) {
    return normalizeName(accountName) + "\x1f" + normalizeName(charName);
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

  /**
   * Gather phase: fetch bible meta (if not cached) + logs for every char in
   * the roster WITHOUT mutating the doc. Returns an array keyed by the
   * composite account+char identity that `applyAutoManageCollected` can apply
   * to any fresh doc. Split from the monolithic sync so `commitAutoManageOn`
   * can run the bible I/O ONCE, outside saveWithRetry - VersionError retries
   * then skip the I/O and only re-run the in-memory apply.
   */
  async function gatherAutoManageLogsForCharacter(account, character, weekResetStart, rosterFetchCache) {
    const charName = getCharacterName(character);
    const entry = {
      accountName: account.accountName,
      charName,
      // Composite key: accountName + charName. See autoManageEntryKey
      // jsdoc for why charName alone is insufficient.
      entryKey: autoManageEntryKey(account.accountName, charName),
      className: getCharacterClass(character),
      // `meta` is only set when the char wasn't already cached -
      // apply phase propagates this into the fresh doc's character.
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
      const expectedLogName = entry.canonicalName || entry.charName;
      let filteredLogs = filterLogsForCharacter(entry.logs, expectedLogName, normalizeName);
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
        const resolved = await resolveBibleMetaForEntry(
          account,
          character,
          entry,
          rosterFetchCache
        );
        const meta = resolved.meta;
        serial = meta.sn;
        cid = meta.cid;
        rid = meta.rid;
        entry.meta = { sn: serial, cid, rid };
        if (resolved.canonicalName) entry.canonicalName = resolved.canonicalName;
        entry.logs = await fetchBibleLogsSinceWeekReset({
          serial,
          cid,
          rid,
          className: entry.className,
          weekResetStart,
        });
        const refreshedExpectedName = entry.canonicalName || entry.charName;
        filteredLogs = filterLogsForCharacter(entry.logs, refreshedExpectedName, normalizeName);
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
    const nowMs = Date.now();
    for (const account of userDoc.accounts || []) {
      const rosterFetchCache = new Map();
      for (const character of account.characters || []) {
        const entryKey = autoManageEntryKey(account.accountName, getCharacterName(character));
        if (includeEntryKeys && !includeEntryKeys.has(entryKey)) continue;
        // Skip chars flagged "Logs not enabled" within the reprobe window.
        // Re-probe at most daily so a char that flips public-log back ON
        // gets picked up by the next gather without manual intervention.
        // includeEntryKeys overrides the gate so explicit caller selects
        // (probe path, single-char retries) always run.
        const flaggedAt = character.publicLogDisabledAt
          ? new Date(character.publicLogDisabledAt).getTime()
          : 0;
        if (
          !includeEntryKeys &&
          character.publicLogDisabled &&
          flaggedAt > 0 &&
          nowMs - flaggedAt < PUBLIC_LOG_DISABLED_REPROBE_MS
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

  /**
   * Apply phase: pure in-memory mutation - take pre-gathered per-char data
   * and reconcile against a (possibly-just-re-fetched) user doc. NO I/O.
   * Safe to call multiple times under saveWithRetry.
   */
  function applyAutoManageCollected(userDoc, weekResetStart, collected) {
    const report = { appliedTotal: 0, perChar: [] };
    // Key by composite account+char identity so same-name chars across
    // different rosters don't collide. See autoManageEntryKey jsdoc.
    const byKey = new Map(collected.map((c) => [c.entryKey, c]));

    for (const account of userDoc.accounts || []) {
      for (const character of account.characters || []) {
        const charName = getCharacterName(character);
        const entry = {
          accountName: account.accountName,
          charName,
          className: getCharacterClass(character),
          applied: [],
          error: null,
        };
        const gathered = byKey.get(autoManageEntryKey(account.accountName, charName));
        if (!gathered) {
          // Char was added between gather and apply (e.g. concurrent
          // /raid-add-roster-char). Skip silently - next /raid-auto-manage run
          // will pick it up.
          continue;
        }
        if (gathered.error) {
          entry.error = gathered.error;
          // Stamp the public-log-off flag for the /raid-check Edit exception.
          // Bible-returned "Logs not enabled" is the only reliable per-char
          // signal we have that the owner's public log toggle is OFF for
          // THIS char specifically, so the leader Edit flow can let managers
          // manually move progress the auto-sync path can never reach.
          if (isPublicLogDisabledError(gathered.error)) {
            character.publicLogDisabled = true;
            // Stamp the timestamp so the 24h reprobe gate in gather can
            // skip this char until the next probe window. Always refresh
            // on every 403 hit so the gate resets if the user has not yet
            // flipped public-log back ON during the previous window.
            character.publicLogDisabledAt = new Date();
          }
          report.perChar.push(entry);
          continue;
        }
        try {
          if (gathered.canonicalName && getCharacterName(character) !== gathered.canonicalName) {
            character.name = gathered.canonicalName;
            entry.charName = gathered.canonicalName;
          }
          if (gathered.meta) {
            character.bibleSerial = gathered.meta.sn;
            character.bibleCid = gathered.meta.cid;
            character.bibleRid = gathered.meta.rid;
          }
          const applied = reconcileCharacterFromLogs(
            character,
            gathered.logs || [],
            weekResetStart
          );
          entry.applied = applied;
          report.appliedTotal += applied.length;
          // Successful sync means the owner's public log is ON for this
          // char right now. Clear any stale flag so a char that flipped
          // log-public between syncs stops being marked "manager edit only".
          if (character.publicLogDisabled) {
            character.publicLogDisabled = false;
            character.publicLogDisabledAt = null;
          }
        } catch (err) {
          entry.error = err?.message || String(err);
          console.warn(
            `[auto-manage] apply for ${charName} failed:`,
            err?.message || err
          );
        }
        report.perChar.push(entry);
      }
    }

    return report;
  }

  /**
   * Convenience wrapper preserved for the probe path (no-save, single-pass
   * in-memory sim) and /raid-auto-manage action:sync (which also wraps with
   * saveWithRetry + gather-outside via its caller). Composes gather + apply
   * against the SAME doc.
   */
  async function syncAutoManageForUserDoc(userDoc, weekResetStart) {
    const collected = await gatherAutoManageLogsForUserDoc(userDoc, weekResetStart);
    return applyAutoManageCollected(userDoc, weekResetStart, collected);
  }

  async function stampAutoManageAttempt(discordId) {
    try {
      await User.updateOne(
        { discordId },
        { $set: { lastAutoManageAttemptAt: Date.now() } }
      );
    } catch (err) {
      console.warn(
        "[auto-manage] stamp attempt failed:",
        err?.message || err
      );
    }
  }

  function isPublicLogDisabledError(err) {
    if (!err) return false;
    // Must match the bible-specific body ("Logs not enabled") - generic 403 is
    // ambiguous (Cloudflare / rate-limit / IP block all return 403 too) and
    // toggling Public Log will NOT fix Cloudflare, so misclassifying these
    // would mislead the user. Body text confirmed in reference_bible_api.md.
    const msg = String(err);
    return /logs\s*not\s*enabled/i.test(msg);
  }

  /**
   * Commit the "auto-manage on" transition: flip the flag, apply fresh
   * bible sync data against a re-fetched User doc, stamp
   * lastAutoManageAttemptAt (and lastAutoManageSyncAt if any char fetched
   * without error), save.
   *
   * Bible I/O runs in a gather phase OUTSIDE `saveWithRetry` so a VersionError
   * during save doesn't re-fire HTTP calls - the apply phase inside the retry
   * loop is pure in-memory mutation. Pre-gathered data from the probe phase
   * can be passed via `preCollected` to avoid the second (commit-phase) bible
   * run; when omitted, commit gathers on its own.
   *
   * Returns the sync report so the caller can render it. Safe to call under
   * an acquired sync slot - it only does findOne/save cycles and does not
   * re-acquire the slot.
   */
  async function commitAutoManageOn(discordId, weekResetStart, preCollected = null) {
    let collected = preCollected;
    if (!collected) {
      const seedDoc = await User.findOne({ discordId });
      if (!seedDoc) return undefined;
      if (!Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
        // No roster - flip flag only, no bible to hit.
        await User.findOneAndUpdate(
          { discordId },
          { $set: { autoManageEnabled: true, lastAutoManageAttemptAt: Date.now() } },
          { upsert: true, setDefaultsOnInsert: true }
        );
        return { appliedTotal: 0, perChar: [] };
      }
      ensureFreshWeek(seedDoc);
      collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart);
    }

    let finalReport;
    let finalUserDocSnapshot = null;
    await saveWithRetry(async () => {
      const fresh = await User.findOne({ discordId });
      if (!fresh) return;
      finalUserDocSnapshot = null;
      fresh.autoManageEnabled = true;
      if (!Array.isArray(fresh.accounts) || fresh.accounts.length === 0) {
        fresh.lastAutoManageAttemptAt = Date.now();
        await fresh.save();
        return;
      }
      ensureFreshWeek(fresh);
      finalReport = applyAutoManageCollected(fresh, weekResetStart, collected);
      const now = Date.now();
      stampAutoManageAttemptFromReport(fresh, finalReport, now);
      await fresh.save();
      finalUserDocSnapshot = toPlainUserDoc(fresh);
    });
    await syncRaidProfileAfterAutoManageReport({
      syncRaidProfileFromBibleCollected,
      report: finalReport,
      discordId,
      userDoc: finalUserDocSnapshot,
      weekResetStart,
      collected,
      logLabel: "[auto-manage:on]",
    });
    return finalReport;
  }

  function weekResetStartMs(now = new Date()) {
    // Inverse of getTargetCleanupDayKey-ish logic: find the most recent
    // weekly-reset boundary that has passed - **5pm Wednesday VN time**
    // (17:00 VN = 10:00 UTC, UTC+7). Matches the weekly-reset module so
    // "this week" means "after the last weekly-reset moment."
    const cursor = new Date(now.getTime());
    // Walk backwards day-by-day up to 7 days until we find the last
    // passed Wed 10:00 UTC moment (= 5pm Wednesday VN).
    for (let i = 0; i < 8; i += 1) {
      const day = cursor.getUTCDay(); // 0=Sun .. 6=Sat
      if (day === 3 && cursor.getUTCHours() >= 10) {
        // Snap to the 10:00 UTC boundary of this Wednesday.
        return Date.UTC(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth(),
          cursor.getUTCDate(),
          10, 0, 0, 0
        );
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      cursor.setUTCHours(23, 59, 59, 999); // roll to end-of-prev-day before next check
    }
    // Fallback: 7 days ago at the current moment.
    return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  }

  return {
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    getAutoManageCooldownMs,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    formatAutoManageCooldownRemaining,
    autoManageEntryKey,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    syncAutoManageForUserDoc,
    stampAutoManageAttempt,
    isPublicLogDisabledError,
    commitAutoManageOn,
    buildAutoManageHiddenCharsWarningEmbed,
    buildAutoManageSyncReportEmbed,
    weekResetStartMs,
  };
}

module.exports = {
  createAutoManageCoreService,
};
