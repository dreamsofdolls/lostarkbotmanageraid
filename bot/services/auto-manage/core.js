"use strict";

const {
  DEFAULT_AUTO_MANAGE_SYNC_COOLDOWN_MS,
  getAutoManageCooldownMs: getAutoManageCooldownMsDefault,
} = require("../access/manager");
const { t } = require("../i18n");
const { getRaidLabel, getModeLabel } = require("../../utils/raid/common/labels");

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
  // Injected so tests can stub per-user cooldown logic without touching env.
  // Falls back to the real manager.js helper (env-driven) in production.
  getAutoManageCooldownMs = getAutoManageCooldownMsDefault,
}) {
  // ---------------------------------------------------------------------------
  // /raid-auto-manage - lostark.bible clear-log sync
  // ---------------------------------------------------------------------------

  // Per-user throttle for /raid-auto-manage sync runs. bibleLimiter already
  // caps concurrency across the whole process, but a single user spamming
  // action:sync still queues N-roster × M-char HTTP calls each time. Two
  // guards combine: in-flight Set rejects parallel runs, cooldown rejects
  // rapid-sequential runs based on User.lastAutoManageAttemptAt.
  //
  // Cooldown is now per-user: non-manager = 10m (the ceiling protecting
  // bible.lostark from spam), manager (in RAID_MANAGER_ID) = 15s so the 2-3
  // operators can resync quickly after reconciling a raid clear. Managers are
  // a small, trusted set so the tighter cadence does not meaningfully raise
  // bible load compared to the existing daily passive scheduler.
  const AUTO_MANAGE_SYNC_COOLDOWN_MS = DEFAULT_AUTO_MANAGE_SYNC_COOLDOWN_MS;
  const AUTO_MANAGE_GATHER_CHARACTER_CONCURRENCY = 2;
  const inFlightAutoManageSyncs = new Set(); // discordId

  /**
   * Atomically claim a sync slot for this user. The slot is reserved
   * BEFORE any `await` so two concurrent interactions racing into this
   * function can't both observe an empty Set - exactly one gets in-flight
   * acquired, the other gets `in-flight` reject. If the DB cooldown check
   * rejects, the slot is released before returning so `on`'s "flip flag
   * only" path doesn't block future sync attempts.
   *
   * Caller contract:
   *   - `acquired: true`  → caller MUST releaseAutoManageSyncSlot() in finally.
   *   - `acquired: false` → slot is NOT held; caller must not release.
   */
  async function acquireAutoManageSyncSlot(discordId, { ignoreCooldown = false } = {}) {
    if (inFlightAutoManageSyncs.has(discordId)) {
      return { acquired: false, reason: "in-flight" };
    }
    // Reserve synchronously - this is the TOCTOU-safe step. Any second
    // caller that reaches this function before we release will see the
    // Set populated and reject.
    inFlightAutoManageSyncs.add(discordId);
    try {
      const user = await User.findOne(
        { discordId },
        { lastAutoManageAttemptAt: 1 }
      ).lean();
      const lastAttempt = user?.lastAutoManageAttemptAt || 0;
      const elapsed = Date.now() - lastAttempt;
      const effectiveCooldownMs = getAutoManageCooldownMs(discordId);
      if (!ignoreCooldown && lastAttempt && elapsed < effectiveCooldownMs) {
        inFlightAutoManageSyncs.delete(discordId);
        return {
          acquired: false,
          reason: "cooldown",
          remainingMs: effectiveCooldownMs - elapsed,
        };
      }
      return { acquired: true };
    } catch (err) {
      // DB blip - release so the user isn't permanently stuck in the Set.
      inFlightAutoManageSyncs.delete(discordId);
      throw err;
    }
  }

  function releaseAutoManageSyncSlot(discordId) {
    inFlightAutoManageSyncs.delete(discordId);
  }

  function formatAutoManageCooldownRemaining(remainingMs) {
    const secs = Math.max(1, Math.ceil(remainingMs / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const rem = secs - mins * 60;
    return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
  }

  /**
   * Fetch a character's lostark.bible identifiers (serial / cid / rid) by
   * loading their roster page and regex-extracting the SSR SvelteKit bootstrap
   * data. These IDs are required to call the logs API but only need to be
   * fetched once per character - caller caches them on the character doc.
   */
  async function fetchBibleCharacterMeta(charName) {
    const url = `https://lostark.bible/character/NA/${encodeURIComponent(charName)}/roster`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LostArkRaidManageBot/1.0)",
        Accept: "text/html",
      },
      // Timeout guards against bible hanging the connection: without it, a
      // stuck fetch holds the `bibleLimiter` slot AND the caller's
      // `inFlightAutoManageSyncs` guard indefinitely, making the user appear
      // "stuck in sync" with no way to recover. Same 15s budget as
      // /raid-add-roster's roster scrape.
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Bible roster page returned HTTP ${res.status} for "${charName}"`);
    }
    const html = await res.text();
    // SSR SvelteKit bootstrap data: {header:{id:<cid>,sn:"<serial>",rid:<rid>,...}}
    const match = html.match(/header:\{id:(\d+),sn:"([^"]+)",rid:(\d+)/);
    if (!match) {
      throw new Error(`Could not parse bible metadata for "${charName}" (page shape changed?)`);
    }
    return { cid: Number(match[1]), sn: match[2], rid: Number(match[3]) };
  }

  /**
   * Call lostark.bible's logs REST API. Returns the raw array of log entries
   * (max 25 per page). Each entry shape: { id, name, boss, difficulty, dps,
   * class, spec, gearScore, combatPower, percentile, duration, timestamp,
   * isBus, isDead }.
   */
  async function fetchBibleCharacterLogs({ serial, cid, rid, className, page = 1 }) {
    const url = "https://lostark.bible/api/character/logs";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; LostArkRaidManageBot/1.0)",
      },
      body: JSON.stringify({
        region: "NA",
        characterSerial: serial,
        className,
        cid,
        rid,
        page,
      }),
      // See fetchBibleCharacterMeta - same hang-protection rationale.
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      // Read body so callers can distinguish "Logs not enabled" (private char,
      // user action fixes it) from Cloudflare/block 403s (bot-infra issue,
      // toggling Public Log won't help). See reference_bible_api.md.
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        bodyText = "";
      }
      const snippet = bodyText ? ` - ${bodyText.slice(0, 200).replace(/\s+/g, " ").trim()}` : "";
      const err = new Error(`Bible logs API returned HTTP ${res.status}${snippet}`);
      err.status = res.status;
      err.bodyText = bodyText;
      throw err;
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  async function fetchBibleLogsWithLimiter({ serial, cid, rid, className, page = 1 }) {
    return bibleLimiter.run(() => fetchBibleCharacterLogs({ serial, cid, rid, className, page }));
  }

  // Route the meta HTML scrape through the same limiter the logs API uses so a
  // cold-cache sync (N chars, each needing both meta + logs) can't double
  // bible's effective concurrency - max 2 in-flight across both endpoints
  // combined, matching the UX promise in HELP_SECTIONS.
  async function fetchBibleCharacterMetaWithLimiter(charName) {
    return bibleLimiter.run(() => fetchBibleCharacterMeta(charName));
  }

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
   * Paginate bible's logs API until we see an entry older than
   * `weekResetStart`, get an empty page, or hit `maxPages`. Bible returns
   * newest-first with 25 entries per page, so one pre-reset entry in a
   * page means every deeper page is irrelevant. Keeps us from missing
   * clears when a char has > 25 weekly-relevant log rows (practice runs,
   * multi-account sharing etc).
   */
  async function fetchBibleLogsSinceWeekReset({ serial, cid, rid, className, weekResetStart, maxPages = 10 }) {
    const all = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const logs = await fetchBibleLogsWithLimiter({ serial, cid, rid, className, page });
      if (!Array.isArray(logs) || logs.length === 0) break;
      all.push(...logs);
      // If any log in this page is before the reset boundary, deeper
      // pages only contain older entries - stop early.
      const hasPreReset = logs.some((l) => Number(l?.timestamp) < weekResetStart);
      if (hasPreReset) break;
      // Partial page = last page bible has.
      if (logs.length < 25) break;
    }
    return all;
  }

  function normalizeDifficultyToModeKey(difficulty) {
    const normalized = normalizeName(difficulty || "");
    if (normalized === "nightmare" || normalized === "9m") return "nightmare";
    if (normalized === "hard" || normalized === "hm") return "hard";
    if (normalized === "normal" || normalized === "nor" || normalized === "nm") return "normal";
    return null;
  }

  /**
   * Given a character doc + array of bible log entries + the current week's
   * reset boundary, mutate `character.assignedRaids` in place to reflect
   * every clear that: (a) belongs to a raid in RAID_REQUIREMENTS, (b)
   * happened at-or-after the week-reset, (c) maps to a known boss via
   * `getRaidGateForBoss`. Returns an array of applied updates for the
   * caller to build a confirmation embed.
   */
  function reconcileCharacterFromLogs(character, logs, weekResetStart) {
    const applied = [];
    if (!Array.isArray(logs) || logs.length === 0) return applied;

    const assignedRaids = ensureAssignedRaids(character);

    // Bible returns newest-first. Process oldest-first so mode-switch
    // wipes always use the *latest* mode as source of truth. Without this,
    // an older Serca Hard clear could wipe a newer Nightmare clear simply
    // because it appears later in the API's newest-first stream.
    const sortedLogs = [...logs].sort(
      (a, b) => (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0)
    );

    for (const log of sortedLogs) {
      const ts = Number(log?.timestamp);
      if (!(ts >= weekResetStart)) continue;

      const mapping = getRaidGateForBoss(log.boss);
      if (!mapping) continue;

      const modeKey = normalizeDifficultyToModeKey(log.difficulty);
      if (!modeKey) continue;

      const raidMeta = RAID_REQUIREMENT_MAP[`${mapping.raidKey}_${modeKey}`];
      if (!raidMeta) continue; // e.g. Kazeros Nightmare if we ever see it but don't track it

      const difficultyLabel = toModeLabel(modeKey);
      const normalizedSelectedDiff = normalizeName(difficultyLabel);

      // Normalize existing raid data + detect mode mismatch (if user cleared
      // Serca Hard earlier but bible also logs a Nightmare clear this week,
      // bible is the source of truth - let the latest-mode win by wiping
      // the raid before writing the new gate).
      const existingRaid = normalizeAssignedRaid(
        assignedRaids[mapping.raidKey] || {},
        difficultyLabel,
        mapping.raidKey
      );

      let modeChange = false;
      if (existingRaid.modeKey && existingRaid.modeKey !== modeKey) {
        modeChange = true;
      }
      for (const g of getGatesForRaid(mapping.raidKey)) {
        const existingDiff = existingRaid[g]?.difficulty;
        if (existingDiff && normalizeName(existingDiff) !== normalizedSelectedDiff) {
          modeChange = true;
          break;
        }
      }
      if (modeChange) {
        for (const g of getGatesForRaid(mapping.raidKey)) {
          existingRaid[g] = { difficulty: difficultyLabel, completedDate: undefined };
        }
      }
      existingRaid.modeKey = modeKey;

      // Only advance completedDate if we don't already have a later clear
      // for this gate. Bible sometimes shows multiple clears per week on
      // the same boss (e.g. practice runs) - latest-ts wins.
      const priorTs = Number(existingRaid[mapping.gate]?.completedDate) || 0;
      if (ts > priorTs) {
        existingRaid[mapping.gate] = {
          difficulty: difficultyLabel,
          completedDate: ts,
        };
        existingRaid.modeKey = modeKey;
        applied.push({
          raidKey: mapping.raidKey,
          raidLabel: raidMeta.label,
          gate: mapping.gate,
          modeKey,
          difficulty: difficultyLabel,
          timestamp: ts,
          boss: log.boss,
        });
      }

      assignedRaids[mapping.raidKey] = existingRaid;
    }

    character.assignedRaids = assignedRaids;
    return applied;
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

  async function mapWithConcurrency(items, limit, mapper) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return [];

    const results = new Array(list.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), list.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < list.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = await mapper(list[index], index);
        }
      })
    );

    return results;
  }

  function filterLogsForCharacter(logs, expectedName) {
    const expected = normalizeName(expectedName);
    if (!expected || !Array.isArray(logs) || logs.length === 0) {
      return { logs: Array.isArray(logs) ? logs : [], mismatchedNames: [], hadNamedLogs: false };
    }
    const namedLogs = logs.filter((log) => normalizeName(log?.name));
    if (namedLogs.length === 0) {
      return { logs, mismatchedNames: [], hadNamedLogs: false };
    }
    const filtered = namedLogs.filter((log) => normalizeName(log?.name) === expected);
    const mismatchedNames = [
      ...new Set(
        namedLogs
          .map((log) => log?.name)
          .filter((name) => normalizeName(name) !== expected)
      ),
    ];
    return { logs: filtered, mismatchedNames, hadNamedLogs: true };
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
      let filteredLogs = filterLogsForCharacter(entry.logs, expectedLogName);
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
        filteredLogs = filterLogsForCharacter(entry.logs, refreshedExpectedName);
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
    for (const account of userDoc.accounts || []) {
      const rosterFetchCache = new Map();
      for (const character of account.characters || []) {
        const entryKey = autoManageEntryKey(account.accountName, getCharacterName(character));
        if (includeEntryKeys && !includeEntryKeys.has(entryKey)) continue;
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
          if (character.publicLogDisabled) character.publicLogDisabled = false;
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
    await saveWithRetry(async () => {
      const fresh = await User.findOne({ discordId });
      if (!fresh) return;
      fresh.autoManageEnabled = true;
      if (!Array.isArray(fresh.accounts) || fresh.accounts.length === 0) {
        fresh.lastAutoManageAttemptAt = Date.now();
        await fresh.save();
        return;
      }
      ensureFreshWeek(fresh);
      finalReport = applyAutoManageCollected(fresh, weekResetStart, collected);
      const now = Date.now();
      fresh.lastAutoManageAttemptAt = now;
      if (finalReport.perChar.some((c) => !c.error)) {
        fresh.lastAutoManageSyncAt = now;
      }
      await fresh.save();
    });
    return finalReport;
  }

  function buildAutoManageHiddenCharsWarningEmbed(hiddenChars, probeReport, lang = "vi") {
    const visibleApplied = (probeReport?.perChar || []).filter(
      (c) => !c.error && Array.isArray(c.applied) && c.applied.length > 0
    );
    const lines = hiddenChars
      .slice(0, 20)
      .map((c) =>
        t("raid-auto-manage.hiddenWarning.charLine", lang, { name: c.charName || "?" }),
      );
    const extra =
      hiddenChars.length > 20
        ? `\n${t("raid-auto-manage.hiddenWarning.charsExtra", lang, {
            n: hiddenChars.length - 20,
          })}`
        : "";

    const description = [
      t("raid-auto-manage.hiddenWarning.descriptionLine1", lang, {
        hidden: hiddenChars.length,
        total: (probeReport?.perChar || []).length,
      }),
      "",
      t("raid-auto-manage.hiddenWarning.charsBlockHeader", lang),
      `${lines.join("\n")}${extra}`,
    ].join("\n");

    const embed = new EmbedBuilder()
      .setColor(UI.colors.progress)
      .setTitle(`${UI.icons.warn} ${t("raid-auto-manage.hiddenWarning.title", lang)}`)
      .setDescription(description)
      .setTimestamp();

    if (visibleApplied.length > 0) {
      const applicableLines = visibleApplied
        .slice(0, 10)
        .map((c) =>
          t("raid-auto-manage.hiddenWarning.applicableLine", lang, {
            name: c.charName,
            n: c.applied.length,
          }),
        );
      const applicableExtra =
        visibleApplied.length > 10
          ? `\n${t("raid-auto-manage.hiddenWarning.applicableExtra", lang, {
              n: visibleApplied.length - 10,
            })}`
          : "";
      embed.addFields({
        name: t("raid-auto-manage.hiddenWarning.applicableHeader", lang),
        value: applicableLines.join("\n") + applicableExtra,
        inline: false,
      });
    }

    embed.addFields({
      name: t("raid-auto-manage.hiddenWarning.optionsHeader", lang),
      value: [
        t("raid-auto-manage.hiddenWarning.optionConfirm", lang),
        t("raid-auto-manage.hiddenWarning.optionCancel", lang),
        t("raid-auto-manage.hiddenWarning.optionTimeout", lang),
      ].join("\n"),
      inline: false,
    });

    return embed;
  }

  const EMBED_FIELD_VALUE_LIMIT = 1024;

  function splitEmbedFieldValue(value, limit = EMBED_FIELD_VALUE_LIMIT) {
    const chunks = [];
    let current = "";

    for (const rawLine of String(value || "").split("\n")) {
      const lineParts = [];
      let remaining = rawLine;
      while (remaining.length > limit) {
        let cutAt = remaining.lastIndexOf(" ", limit);
        if (cutAt < Math.floor(limit * 0.6)) cutAt = limit;
        lineParts.push(remaining.slice(0, cutAt).trimEnd());
        remaining = remaining.slice(cutAt).trimStart();
      }
      lineParts.push(remaining);

      for (const part of lineParts) {
        const next = current ? `${current}\n${part}` : part;
        if (next.length > limit && current) {
          chunks.push(current);
          current = part;
        } else {
          current = next;
        }
      }
    }

    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : ["_No details_"];
  }

  function addChunkedEmbedField(embed, name, value) {
    const chunks = splitEmbedFieldValue(value);
    chunks.forEach((chunk, index) => {
      embed.addFields({
        name: index === 0 ? name : `${name} (${index + 1})`,
        value: chunk,
        inline: false,
      });
    });
  }

  function buildAutoManageSyncReportEmbed(report, lang = "vi") {
    const appliedTotal = report?.appliedTotal || 0;
    const perChar = Array.isArray(report?.perChar) ? report.perChar : [];
    const errored = perChar.filter((c) => c.error);
    const withApplied = perChar.filter((c) => c.applied.length > 0);
    const allFailed = perChar.length > 0 && errored.length === perChar.length;

    // Three-state description so the user never sees "DB đã match" stapled
    // to a Fail field - ambiguous and looked like a bug in Codex review.
    let description;
    if (appliedTotal > 0) {
      description = t("raid-auto-manage.syncReport.descriptionApplied", lang, {
        n: appliedTotal,
      });
      if (errored.length > 0) {
        description += `\n${t("raid-auto-manage.syncReport.descriptionAppliedFailsTail", lang, {
          warnIcon: UI.icons.warn,
          n: errored.length,
        })}`;
      }
    } else if (allFailed) {
      description = t("raid-auto-manage.syncReport.descriptionAllFailed", lang, {
        n: errored.length,
      });
    } else if (errored.length > 0) {
      description = t("raid-auto-manage.syncReport.descriptionNoNewWithFails", lang, {
        warnIcon: UI.icons.warn,
        failed: errored.length,
        total: perChar.length,
      });
    } else {
      description = t("raid-auto-manage.syncReport.descriptionNoNew", lang);
    }

    const embed = new EmbedBuilder()
      .setColor(
        appliedTotal > 0
          ? UI.colors.success
          : allFailed
            ? UI.colors.progress
            : UI.colors.neutral
      )
      .setTitle(
        `${appliedTotal > 0 ? UI.icons.done : UI.icons.info} ${t(
          "raid-auto-manage.syncReport.title",
          lang,
        )}`,
      )
      .setDescription(description)
      .setTimestamp();

    for (const c of withApplied.slice(0, 10)) {
      const lines = c.applied.map((a) =>
        t("raid-auto-manage.syncReport.appliedLine", lang, {
          // raidKey + modeKey are stamped on each applied entry by
          // applyAutoManageCollected; resolve to the locale-aware label
          // here so the report reads as "アクト4" / "Act 4" / "Act 4"
          // depending on the viewer's preference instead of the canonical
          // English raidLabel snapshot stored on the entry.
          raidLabel: a.raidKey ? getRaidLabel(a.raidKey, lang) : a.raidLabel,
          gate: a.gate,
          // a.difficulty is the canonical EN difficulty string written by
          // the bible parser; map back to a modeKey when present so we
          // can surface localized "ハード" / "Hard" / "Hard".
          difficulty: a.modeKey ? getModeLabel(a.modeKey, lang) : a.difficulty,
        }),
      );
      embed.addFields({
        name: t("raid-auto-manage.syncReport.appliedFieldName", lang, {
          icon: UI.icons.done,
          charName: c.charName,
          accountName: c.accountName,
        }),
        value: lines.join("\n"),
        inline: false,
      });
    }
    if (withApplied.length > 10) {
      embed.addFields({
        name: t("raid-auto-manage.syncReport.moreCharsHeader", lang),
        value: t("raid-auto-manage.syncReport.moreCharsBody", lang, {
          n: withApplied.length - 10,
        }),
      });
    }

    if (errored.length > 0) {
      // Per-line hard cap so one HTML-heavy Cloudflare 403 body (fetch now
      // embeds up to 200 chars of response body into err.message) can't blow
      // past Discord's 1024-char field limit on its own. addChunkedHelpField
      // below handles the aggregate case (many errors) by splitting into
      // continuation fields.
      const MAX_ERROR_LINE = 180;
      const DISPLAY_LIMIT = 10;
      const lines = errored.slice(0, DISPLAY_LIMIT).map((c) => {
        const raw = `\`${c.charName}\`: ${c.error}`;
        return raw.length > MAX_ERROR_LINE
          ? `${raw.slice(0, MAX_ERROR_LINE - 1)}…`
          : raw;
      });
      if (errored.length > DISPLAY_LIMIT) {
        lines.push(
          t("raid-auto-manage.syncReport.failsExtra", lang, {
            n: errored.length - DISPLAY_LIMIT,
          }),
        );
      }
      addChunkedEmbedField(
        embed,
        t("raid-auto-manage.syncReport.failsHeader", lang, {
          warnIcon: UI.icons.warn,
          count: errored.length,
        }),
        lines.join("\n")
      );
    }

    return embed;
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
