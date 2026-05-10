"use strict";

const { t, getGuildLanguage, getUserLanguage } = require("../i18n");
const { TRANSLATIONS, DEFAULT_LANGUAGE } = require("../../locales");

// Helper - read an array-shaped locale node (e.g.
// `announcements.cleanup-volume.empty`). Falls back to the VI tree when the
// target locale is missing the key OR doesn't return an array, then to an
// empty array as the absolute last resort. Keeps the variant-pick path
// safe even if a locale pack adds the namespace incomplete.
function lookupArray(lang, dottedKey) {
  const tryPath = (code) => {
    const tree = TRANSLATIONS[code];
    if (!tree) return null;
    let cursor = tree;
    for (const seg of dottedKey.split(".")) {
      if (cursor == null || typeof cursor !== "object") return null;
      cursor = cursor[seg];
    }
    return Array.isArray(cursor) ? cursor : null;
  };
  return tryPath(lang) || tryPath(DEFAULT_LANGUAGE) || [];
}

function createRaidSchedulerService({
  GuildConfig,
  User,
  saveWithRetry,
  ensureFreshWeek,
  getAnnouncementsConfig,
  cleanupRaidChannelMessages,
  weekResetStartMs,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  isPublicLogDisabledError,
  stampAutoManageAttempt,
}) {
  // ---------------------------------------------------------------------------
  // Auto-cleanup scheduler (every 30 minutes in Vietnam time)
  // ---------------------------------------------------------------------------

  const AUTO_CLEANUP_NOTICE_TTL_MS = 5 * 60 * 1000; // marker sits 5 min before self-delete
  const ARTIST_BEDTIME_NOTICE_TTL_MS = 5 * 60 * 1000;
  const ARTIST_WAKEUP_NOTICE_TTL_MS = 10 * 60 * 1000; // longer so 8am members catch it
  // Quiet-hours window in VN local time. Artist skips cleanup + posts no
  // ticks in [QUIET_START_HOUR, QUIET_END_HOUR). Message handling is
  // unaffected - users can still post raid clears in the middle of the
  // night, Artist just doesn't patrol.
  const ARTIST_QUIET_START_HOUR_VN = 3;
  const ARTIST_QUIET_END_HOUR_VN = 8;
  // Per-language tz offset (minutes from UTC) for the persona-event
  // schedulers below: artist-bedtime fires at 3am LOCAL, artist-wakeup
  // at 8am LOCAL, quiet-hours window in [3am, 8am) LOCAL. Default-vi
  // guilds keep the legacy +7h VN clock; jp guilds anchor to JST (+9h);
  // en guilds anchor to UTC. LA-event-anchored schedulers (weekly reset,
  // maintenance) are NOT affected by this - those fire at the same
  // absolute moment for every guild, just rendered in each language's
  // display tz via the locale strings.
  const LANG_TZ_OFFSET_MINUTES = {
    vi: 7 * 60,
    jp: 9 * 60,
    en: 0,
  };
  function getLangTzOffsetMinutes(lang) {
    return LANG_TZ_OFFSET_MINUTES[lang] ?? LANG_TZ_OFFSET_MINUTES.vi;
  }
  const PRIVATE_LOG_NUDGE_TTL_MS = 30 * 60 * 1000; // stuck-user nudge sits 30 min before self-delete
  const PRIVATE_LOG_NUDGE_DEDUP_MS = 7 * 24 * 60 * 60 * 1000; // 7-day per-user dedup
  const AUTO_CLEANUP_TICK_MS = 30 * 60 * 1000;
  let autoCleanupSchedulerStartedAtMs = null;
  let autoCleanupTickInFlight = false;

  /**
   * Fire-and-forget channel announcement with TTL self-delete. Returns the
   * sent Message on success (so caller can stamp dedup cursors only on
   * confirmed post), null on send failure. Same pattern as the whisper-ack
   * flow in handleRaidChannelMessage and the hourly-cleanup notice.
   *
   * `ttlMs > 0` schedules a setTimeout to delete the message. `ttlMs = 0`
   * leaves the message permanent (not used currently but left for future
   * callers like persistent markers).
   */
  async function postChannelAnnouncement(channel, content, ttlMs, logTag = "announcement", components) {
    let sent = null;
    try {
      // `components` is optional - older callers pass nothing; the
      // stuck-private-log nudge (Phase 6) passes a single ActionRow with
      // the "Switch to Local Sync" button.
      const payload = { content };
      if (Array.isArray(components) && components.length > 0) {
        payload.components = components;
      }
      sent = await channel.send(payload);
    } catch (err) {
      console.warn(`[${logTag}] send failed:`, err?.message || err);
      return null;
    }
    if (ttlMs > 0) {
      setTimeout(() => {
        sent.delete().catch(() => {});
      }, ttlMs);
    }
    return sent;
  }

  /**
   * Returns "YYYY-MM-DDTHH:MM" in Vietnam (UTC+7) calendar where MM is
   * snapped to "00" or "30". Used as the idempotency cursor
   * `lastAutoCleanupKey`: once a guild runs cleanup for a given VN
   * half-hour slot, subsequent ticks within the same slot short-circuit.
   * Crossing a slot boundary produces a new key and the next tick picks
   * it up.
   *
   * Cadence history: daily (YYYY-MM-DD) → hourly (YYYY-MM-DDTHH) →
   * half-hour (YYYY-MM-DDTHH:MM) per Traine's request. Legacy shorter
   * keys stored in Mongo will never match the new slot key, so the first
   * tick after deploy re-runs cleanup once - harmless one-time re-sweep.
   */
  function getTargetCleanupSlotKey(now = new Date()) {
    const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const dateHour = vnTime.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    const slotMinute = vnTime.getUTCMinutes() < 30 ? "00" : "30";
    return `${dateHour}:${slotMinute}`;
  }

  /**
   * Returns "YYYY-MM-DD" in VN (UTC+7) calendar. Shared dedup key for
   * Artist's once-per-day ceremonial moments (bedtime greeting at 3:00 VN,
   * wake-up + morning sweep at 8:00 VN). Distinct from the half-hour slot
   * key because those ceremonies fire once per calendar day, not per slot.
   */
  function getTargetVNDayKey(now = new Date()) {
    return getTargetDayKeyForLang(now, "vi");
  }

  /**
   * Lang-aware variant: returns "YYYY-MM-DD" in the LOCAL calendar of
   * whatever timezone matches the supplied locale. JP guild's day key
   * rolls at midnight JST; EN guild's at midnight UTC. Used as dedup key
   * for once-per-day persona events (bedtime / wakeup).
   */
  function getTargetDayKeyForLang(now = new Date(), lang) {
    const offsetMs = getLangTzOffsetMinutes(lang) * 60 * 1000;
    const localTime = new Date(now.getTime() + offsetMs);
    return localTime.toISOString().slice(0, 10);
  }

  /**
   * VN local hour (0-23). Used to decide whether a tick falls inside the
   * quiet-hours window. The calc mirrors getTargetCleanupSlotKey so both
   * helpers stay in lockstep if the UTC offset ever changes.
   */
  function getCurrentVNHour(now = new Date()) {
    return getCurrentHourForLang(now, "vi");
  }

  /**
   * Lang-aware variant: returns the local hour (0-23) in the timezone
   * matching the supplied locale. JP guild's "current hour" reads JST,
   * EN guild's reads UTC. Default vi keeps the legacy VN behavior.
   */
  function getCurrentHourForLang(now = new Date(), lang) {
    const offsetMs = getLangTzOffsetMinutes(lang) * 60 * 1000;
    const localTime = new Date(now.getTime() + offsetMs);
    return localTime.getUTCHours();
  }

  /**
   * True when the current VN hour is inside Artist's quiet window. The
   * window is half-open: [QUIET_START_HOUR, QUIET_END_HOUR). Hour 8 is NOT
   * quiet - it's the wake-up hour where the catch-up cleanup runs. Hour 2
   * is NOT quiet - the last pre-bedtime cleanup slot at 2:30 runs as usual.
   */
  function isInArtistQuietHours(now = new Date()) {
    return isInArtistQuietHoursForLang(now, "vi");
  }

  /**
   * Lang-aware quiet-hours check. Per-guild scheduler tick resolves the
   * guild's lang first, then asks "are we in [3am, 8am) of THAT guild's
   * local timezone?". Vi guild quiets 3-8 VN; JP guild quiets 3-8 JST;
   * EN guild quiets 3-8 UTC.
   */
  function isInArtistQuietHoursForLang(now = new Date(), lang) {
    const hour = getCurrentHourForLang(now, lang);
    return hour >= ARTIST_QUIET_START_HOUR_VN && hour < ARTIST_QUIET_END_HOUR_VN;
  }

  /**
   * True once the VN local clock reaches Artist's 08:00 wake-up boundary.
   * This must NOT be inferred from `!isInArtistQuietHours()` because
   * 00:00-02:59 VN is outside quiet hours too, yet still belongs to the
   * previous day rhythm and must not trigger the wake-up sweep early.
   */
  function hasReachedArtistWakeupBoundary(now = new Date()) {
    return hasReachedArtistWakeupBoundaryForLang(now, "vi");
  }

  /**
   * Lang-aware wakeup boundary check. Triggered once the local clock
   * crosses 08:00 in the guild's tz. Same rule as the legacy VN version.
   */
  function hasReachedArtistWakeupBoundaryForLang(now = new Date(), lang) {
    return getCurrentHourForLang(now, lang) >= ARTIST_QUIET_END_HOUR_VN;
  }

  /**
   * Variant pool per cleanup-count bucket. Random pick at fire time gives
   * the channel a more lived-in tone instead of a single repeating line.
   * Buckets sized empirically: 0 = silent channel (idle marker), 1-5 = a
   * few stragglers, 6-20 = typical night of posting, 21+ = backlog.
   *
   * Voice (VN default): "cắm tạm biển / nghỉ / sủi" instead of the earlier
   * "tự biến / tự dọn" phrasing per Traine. JP/EN locales hold their own
   * tone-equivalent variants. Pools resolve via lookupArray at fire time
   * with the guild's broadcast language; {N} interp = sweep count.
   */
  function pickCleanupNoticeContent(deleted, lang = DEFAULT_LANGUAGE) {
    let bucket;
    if (deleted <= 0) bucket = "empty";
    else if (deleted <= 5) bucket = "trivial";
    else if (deleted <= 20) bucket = "normal";
    else bucket = "heavy";
    const pool = lookupArray(lang, `announcements.cleanup-volume.${bucket}`);
    if (pool.length === 0) return "";
    const picked = pool[Math.floor(Math.random() * pool.length)];
    return picked.replace(/\{N\}/g, deleted);
  }

  /**
   * Random pick from bedtime pool. Flat list (no bucketing) because the
   * event is always the same - Artist is going quiet, sweep count not
   * relevant at this moment. Pool resolves via lookupArray at fire time
   * with the guild's broadcast language.
   */
  function pickBedtimeNoticeContent(lang = DEFAULT_LANGUAGE) {
    const pool = lookupArray(lang, "announcements.artist-bedtime.variants");
    if (pool.length === 0) return "";
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Random pick from the wake-up/morning-sweep pool with the same
   * bucketing as the hourly-cleanup notice (empty / trivial / normal /
   * heavy by sweep count). Separate pool from the hourly one so 8 AM
   * never reuses an "afternoon" line - the ceremonial tone matters even
   * when the count matches a regular heavy cleanup.
   */
  function pickWakeupNoticeContent(deleted, lang = DEFAULT_LANGUAGE) {
    let bucket;
    if (deleted <= 0) bucket = "empty";
    else if (deleted <= 5) bucket = "trivial";
    else if (deleted <= 20) bucket = "normal";
    else bucket = "heavy";
    const pool = lookupArray(lang, `announcements.artist-wakeup.${bucket}`);
    if (pool.length === 0) return "";
    const picked = pool[Math.floor(Math.random() * pool.length)];
    return picked.replace(/\{N\}/g, deleted);
  }

  // Ordered bucket metadata for rendering the cleanup preview. Pulled out
  // of the pool so preview listing stays stable order (empty -> heavy) and
  // the label text isn't duplicated in two places. Labels stay VN here
  // because /raid-announce show is admin-facing and renders alongside
  // other admin scaffolding that's English; preview body itself comes
  // from the locale tree (default VI for the admin-facing render).
  const CLEANUP_NOTICE_BUCKETS_ORDERED = [
    { key: "empty", label: "Sạch sẵn (0 tin)" },
    { key: "trivial", label: "Nhẹ (1-5 tin)" },
    { key: "normal", label: "Vừa (6-20 tin)" },
    { key: "heavy", label: "Nhiều (21+ tin)" },
  ];

  /**
   * Build the /raid-announce show preview text for the hourly-cleanup
   * type from the locale variant arrays so admins see every variant
   * Artist might actually post. Renders in VI (default) since the rest
   * of /raid-announce show is in admin-facing VI/EN scaffolding. Each
   * variant is truncated to VARIANT_MAX so the whole field stays under
   * Discord's 1024-char field value cap.
   */
  function buildCleanupNoticePreview() {
    // 60 chars/variant keeps total under Discord's 1024-char field cap
    // across 4 buckets × 3 variants + 4 bucket headers + intro line.
    const VARIANT_MAX = 60;
    const lines = ["Random pick mỗi lần fire theo lượng rác:"];
    for (const { key, label } of CLEANUP_NOTICE_BUCKETS_ORDERED) {
      const pool = lookupArray(DEFAULT_LANGUAGE, `announcements.cleanup-volume.${key}`);
      lines.push("");
      lines.push(`**${label}** - ${pool.length} variants:`);
      for (const variant of pool) {
        const shortened =
          variant.length > VARIANT_MAX ? variant.slice(0, VARIANT_MAX) + "..." : variant;
        lines.push(`• ${shortened}`);
      }
    }
    return lines.join("\n");
  }

  async function runAutoCleanupTick(client) {
    const now = new Date();
    const targetKey = getTargetCleanupSlotKey(now);
    // dayKey + quiet are computed PER cfg below now (not here at tick
    // start) because each guild can pick its own broadcast language via
    // /raid-channel set-language, which anchors quiet-hours + bedtime
    // dedup keys to that guild's local clock instead of always VN.
    let configs;
    try {
      configs = await GuildConfig.find({
        autoCleanupEnabled: true,
        raidChannelId: { $ne: null },
      }).lean();
    } catch (err) {
      console.error("[raid-channel] auto-cleanup config load failed:", err?.message || err);
      return;
    }
    if (!configs.length) return;

    for (const cfg of configs) {
      const guild = client.guilds.cache.get(cfg.guildId);
      if (!guild) continue;
      let channel = guild.channels.cache.get(cfg.raidChannelId);
      if (!channel) {
        try {
          channel = await guild.channels.fetch(cfg.raidChannelId);
        } catch {
          continue;
        }
      }
      if (!channel) continue;

      const announcements = getAnnouncementsConfig(cfg);
      // Per-guild broadcast language - resolved once per cfg per tick. Used
      // by every announcement variant pool below (bedtime, wakeup, cleanup)
      // so a JP/EN guild renders in its chosen voice while the legacy
      // default-VI guilds keep their existing tone. Also drives the
      // quiet-hours / wake-up boundary checks below so persona events
      // anchor to the guild's local clock (3am JST for jp, 3am UTC for
      // en, 3am VN for vi).
      const guildLang = await getGuildLanguage(cfg.guildId, { GuildConfigModel: GuildConfig });
      const dayKey = getTargetDayKeyForLang(now, guildLang);
      const quiet = isInArtistQuietHoursForLang(now, guildLang);

      // Quiet-hours branch: [3:00, 8:00) LOCAL TIME of the guild's
      // configured language. Artist does NOT sweep and does NOT post the
      // hourly-cleanup notice. First tick after 3:00 local posts one
      // bedtime greeting (if enabled + not yet posted today); subsequent
      // quiet-hours ticks are silent no-ops. The dedup key is the local
      // calendar day so a bot restart inside [3:00, 8:00) on the same
      // local day won't re-fire bedtime.
      if (quiet) {
        if (cfg.lastArtistBedtimeKey === dayKey) continue;
        if (!announcements.artistBedtime.enabled) {
          // Bedtime disabled per-guild → still stamp the day key so we
          // don't keep entering this branch; the guild just gets silence.
          try {
            await GuildConfig.findOneAndUpdate(
              { guildId: cfg.guildId },
              { $set: { lastArtistBedtimeKey: dayKey } }
            );
          } catch (err) {
            console.error(
              `[raid-channel] artist-bedtime disabled-stamp failed guild=${cfg.guildId}:`,
              err?.message || err
            );
          }
          continue;
        }
        try {
          const sent = await postChannelAnnouncement(
            channel,
            pickBedtimeNoticeContent(guildLang),
            ARTIST_BEDTIME_NOTICE_TTL_MS,
            "raid-channel artist-bedtime"
          );
          if (sent) {
            await GuildConfig.findOneAndUpdate(
              { guildId: cfg.guildId },
              { $set: { lastArtistBedtimeKey: dayKey } }
            );
            console.log(
              `[raid-channel] artist-bedtime guild=${cfg.guildId} day=${dayKey}`
            );
          }
        } catch (err) {
          console.error(
            `[raid-channel] artist-bedtime failed guild=${cfg.guildId}:`,
            err?.message || err
          );
        }
        continue;
      }

      // Wake-up branch: first tick ≥ 8:00 VN on a day where wake-up has
      // not fired yet. Sweep the overnight backlog in one catch-up pass
      // and post the combined wake-up+sweep notice. Subsequent ticks that
      // day fall through to the normal hourly-cleanup path because the
      // day key will match.
      if (hasReachedArtistWakeupBoundaryForLang(now, guildLang) && cfg.lastArtistWakeupKey !== dayKey) {
        try {
          const { deleted, skippedOld } = await cleanupRaidChannelMessages(channel);
          await GuildConfig.findOneAndUpdate(
            { guildId: cfg.guildId },
            {
              $set: {
                lastArtistWakeupKey: dayKey,
                lastAutoCleanupKey: targetKey,
              },
            }
          );
          console.log(
            `[raid-channel] artist-wakeup guild=${cfg.guildId} day=${dayKey} deleted=${deleted} skippedOld=${skippedOld}`
          );
          if (announcements.artistWakeup.enabled) {
            await postChannelAnnouncement(
              channel,
              pickWakeupNoticeContent(deleted, guildLang),
              ARTIST_WAKEUP_NOTICE_TTL_MS,
              "raid-channel artist-wakeup"
            );
          }
        } catch (err) {
          console.error(
            `[raid-channel] artist-wakeup failed guild=${cfg.guildId}:`,
            err?.message || err
          );
        }
        continue;
      }

      // Normal hourly-cleanup path. Slot dedup: one sweep per half-hour
      // VN slot. Crossing a slot boundary produces a new key and the next
      // tick picks it up.
      if (cfg.lastAutoCleanupKey === targetKey) continue;

      try {
        // Run cleanup first, then post a tone-aware notice in EITHER case:
        //   - deleted > 0  → grumpy "just dọn N tin" tone (there was work).
        //   - deleted == 0 → content "channel đã sạch sẵn" tone (nothing to
        //     do, Artist lounges 5 phút then leaves).
        // Both notices self-delete after AUTO_CLEANUP_NOTICE_TTL_MS. Reason
        // to speak even when idle: silence during a scheduled job window
        // reads as "bot offline/broken" - a content-tone notice doubles as
        // heartbeat + idle-state marker.
        const { deleted, skippedOld } = await cleanupRaidChannelMessages(channel);
        await GuildConfig.findOneAndUpdate(
          { guildId: cfg.guildId },
          { $set: { lastAutoCleanupKey: targetKey } }
        );
        console.log(
          `[raid-channel] auto-cleanup guild=${cfg.guildId} key=${targetKey} deleted=${deleted} skippedOld=${skippedOld}`
        );

        // Cleanup notice can be disabled per-guild via /raid-announce.
        // Cleanup itself still runs; only the announcement is skipped.
        if (announcements.hourlyCleanupNotice.enabled) {
          const noticeContent = pickCleanupNoticeContent(deleted, guildLang);
          await postChannelAnnouncement(
            channel,
            noticeContent,
            AUTO_CLEANUP_NOTICE_TTL_MS,
            "raid-channel auto-cleanup"
          );
        }
      } catch (err) {
        console.error(
          `[raid-channel] auto-cleanup failed guild=${cfg.guildId}:`,
          err?.message || err
        );
      }
    }
  }

  /**
   * Start the 30-minute tick for the auto-cleanup scheduler. With the hourly
   * cadence (Apr 2026), tick every 30 min so an hour-boundary crossing is
   * caught within 30 min worst-case. The tick itself is idempotent via
   * `lastAutoCleanupKey` so no-op ticks are cheap. The in-flight guard keeps
   * a slow cleanup pass from overlapping the next interval fire before the
   * per-guild key is stamped.
   */
  function startRaidChannelScheduler(client) {
    autoCleanupSchedulerStartedAtMs = Date.now();
    const run = async () => {
      if (autoCleanupTickInFlight) {
        console.warn(
          "[raid-channel] previous scheduler tick still running - skipping this fire to avoid overlap"
        );
        return;
      }
      autoCleanupTickInFlight = true;
      try {
        await runAutoCleanupTick(client);
      } catch (err) {
        console.error("[raid-channel] scheduler tick failed:", err?.message || err);
      } finally {
        autoCleanupTickInFlight = false;
      }
    };
    run();
    return setInterval(run, AUTO_CLEANUP_TICK_MS);
  }

  // ---------------------------------------------------------------------------
  // Maintenance reminder scheduler (LA VN weekly maintenance: Wednesday 14:00 VN)
  // ---------------------------------------------------------------------------
  // Lost Ark VN maintenance is fixed at Wednesday 14:00 VN. Hard-coded
  // here rather than configurable per guild because (a) the schedule is
  // tied to the publisher
  // not the server, (b) a single global truth avoids drift if multiple guilds
  // ever join, and (c) keeping the value as constants means changing the
  // schedule is a one-line PR if LA VN ever shifts the boundary.
  const MAINTENANCE_DAY_VN = 3; // 0=Sun, 3=Wed
  const MAINTENANCE_HOUR_VN = 14;
  const MAINTENANCE_MINUTE_VN = 0;
  const MAINTENANCE_TICK_MS = 60 * 1000; // 1-min cadence to catch every slot
  // TTL per group: early reminders linger 30 min (members may scroll back),
  // countdown reminders self-delete faster because the next slot is right behind
  // them. T-1m TTL is shortest because the server is about to be down anyway.
  const MAINTENANCE_TTL_EARLY_MS = 30 * 60 * 1000;
  const MAINTENANCE_TTL_COUNTDOWN_MS = 10 * 60 * 1000;
  const MAINTENANCE_TTL_FINAL_MS = 5 * 60 * 1000;
  let maintenanceSchedulerStartedAtMs = null;

  // Slot definitions: minutesBefore = minutes before the 14:00 VN boundary. Two
  // separate arrays so the per-group enabled flag and per-group dedup key
  // map cleanly to MAINTENANCE_EARLY_SLOTS vs MAINTENANCE_COUNTDOWN_SLOTS.
  // `pingHere` only true for the 2 milestones Traine flagged (T-3h, T-1h).
  const MAINTENANCE_EARLY_SLOTS = [
    { key: "T-3h", minutesBefore: 180, ttlMs: MAINTENANCE_TTL_EARLY_MS, pingHere: true },
    { key: "T-2h", minutesBefore: 120, ttlMs: MAINTENANCE_TTL_EARLY_MS, pingHere: false },
    { key: "T-1h", minutesBefore: 60, ttlMs: MAINTENANCE_TTL_EARLY_MS, pingHere: true },
  ];
  const MAINTENANCE_COUNTDOWN_SLOTS = [
    { key: "T-15m", minutesBefore: 15, ttlMs: MAINTENANCE_TTL_COUNTDOWN_MS, pingHere: false },
    { key: "T-10m", minutesBefore: 10, ttlMs: MAINTENANCE_TTL_COUNTDOWN_MS, pingHere: false },
    { key: "T-5m", minutesBefore: 5, ttlMs: MAINTENANCE_TTL_COUNTDOWN_MS, pingHere: false },
    { key: "T-1m", minutesBefore: 1, ttlMs: MAINTENANCE_TTL_FINAL_MS, pingHere: false },
  ];

  // Maintenance slot keys live in two locale namespaces: early (T-3h/2h/1h)
  // and countdown (T-15m/10m/5m/1m). 3 variants each so a server doesn't
  // read the same line two weeks in a row. Tone progression baked into the
  // strings: early = checklist reminder (shop solo / event / paradise /
  // key hell), countdown = urgent ticking down, T-1m = "log out now".
  // `@here` baked into the variant text for the 2 milestone slots per
  // Traine. Pools resolve via lookupArray at fire time with the guild's
  // broadcast language.
  function lookupMaintenanceVariants(slotKey, lang) {
    if (slotKey?.startsWith("T-") && /^T-\d+(?:h|m)$/.test(slotKey)) {
      const isEarly = ["T-3h", "T-2h", "T-1h"].includes(slotKey);
      const ns = isEarly ? "maintenance-early" : "maintenance-countdown";
      return lookupArray(lang, `announcements.${ns}.${slotKey}`);
    }
    return [];
  }

  /**
   * Resolve the maintenance slot (if any) that should fire at the given
   * instant. Returns null when the current VN datetime is NOT inside a
   * maintenance reminder window: wrong day-of-week, past the boundary, or
   * the minutesUntil value doesn't exactly match any of the 7 slots.
   *
   * Exact-minute match is intentional: tick cadence is 1 minute and the
   * dedup key prevents double-fire, so a clean equality check is simpler
   * than a tolerance window (which would have ambiguity between adjacent
   * countdown slots only 5 minutes apart). Edge case: a tick delayed > 60s
   * by event-loop pressure can miss its slot, an acceptable trade-off for
   * code clarity. Restart inside the reminder window resumes from the next
   * matching slot forward.
   */
  function getMaintenanceSlotForNow(now = new Date()) {
    const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const dayOfWeek = vn.getUTCDay();
    if (dayOfWeek !== MAINTENANCE_DAY_VN) return null;
    const hour = vn.getUTCHours();
    const minute = vn.getUTCMinutes();
    const minutesUntil =
      (MAINTENANCE_HOUR_VN - hour) * 60 + (MAINTENANCE_MINUTE_VN - minute);
    if (minutesUntil <= 0) return null;
    const earlyMatch = MAINTENANCE_EARLY_SLOTS.find(
      (s) => s.minutesBefore === minutesUntil
    );
    if (earlyMatch) {
      return { slot: earlyMatch, group: "early" };
    }
    const countdownMatch = MAINTENANCE_COUNTDOWN_SLOTS.find(
      (s) => s.minutesBefore === minutesUntil
    );
    if (countdownMatch) {
      return { slot: countdownMatch, group: "countdown" };
    }
    return null;
  }

  /**
   * Pick a random variant from the pool for the given slot key. Returns
   * the raw string (already includes `@here` prefix when applicable, since
   * pingHere is baked into the variant text). Caller passes content
   * directly to postChannelAnnouncement.
   */
  function pickMaintenanceVariant(slotKey, lang = DEFAULT_LANGUAGE) {
    const pool = lookupMaintenanceVariants(slotKey, lang);
    if (pool.length === 0) return "";
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Build the /raid-announce show preview text for a maintenance group
   * from MAINTENANCE_VARIANTS so admins see every variant Artist might
   * actually post per slot. Mirrors the buildCleanupNoticePreview shape:
   * heading per slot, truncated variants, total under Discord 1024 cap.
   */
  function buildMaintenancePreview(group) {
    const slots = group === "early" ? MAINTENANCE_EARLY_SLOTS : MAINTENANCE_COUNTDOWN_SLOTS;
    const VARIANT_MAX = 70;
    const lines = [
      group === "early"
        ? "Random pick mỗi mốc (3 variants/mốc):"
        : "Random pick mỗi mốc (3 variants/mốc, đếm ngược):",
    ];
    for (const s of slots) {
      // Admin preview renders in the default (VI) locale to match the rest
      // of /raid-announce show's admin scaffolding.
      const pool = lookupMaintenanceVariants(s.key, DEFAULT_LANGUAGE);
      lines.push("");
      lines.push(`**${s.key}**${s.pingHere ? " (ping @here)" : ""} - ${pool.length} variants:`);
      for (const variant of pool) {
        const shortened =
          variant.length > VARIANT_MAX ? variant.slice(0, VARIANT_MAX) + "..." : variant;
        lines.push(`- ${shortened}`);
      }
    }
    return lines.join("\n");
  }

  /**
   * Snapshot of the maintenance schedule's wall-clock shape, exposed so
   * scheduling.js can compute "Next eligible boundary" for the 2 maintenance
   * announcement types without re-hard-coding 14:00 VN / Wed / minutesBefore
   * arrays. Single source of truth: changing the constants or slot lists at
   * the top of this section automatically flows into /raid-announce show.
   *
   * VN to UTC offset is fixed at 7 (Vietnam doesn't observe DST), so the
   * subtraction is safe. If that ever changes, this is the only line to fix.
   */
  function getMaintenanceSlotConfigSnapshot() {
    return {
      dayOfWeek: MAINTENANCE_DAY_VN,
      utcHour: MAINTENANCE_HOUR_VN - 7,
      utcMinute: MAINTENANCE_MINUTE_VN,
      earlyMinutes: MAINTENANCE_EARLY_SLOTS.map((s) => s.minutesBefore),
      countdownMinutes: MAINTENANCE_COUNTDOWN_SLOTS.map((s) => s.minutesBefore),
    };
  }

  /**
   * Mongo filter for the maintenance scheduler tick. A guild is eligible
   * when ANY of the 3 channel paths is non-null:
   *   1. raidChannelId (default fallback for both groups)
   *   2. announcements.maintenanceEarly.channelId (override for early)
   *   3. announcements.maintenanceCountdown.channelId (override for countdown)
   *
   * Earlier shape filtered ONLY raidChannelId, which silently dropped any
   * guild that configured an override but hadn't set a monitor channel yet.
   * That contradicted the /raid-announce UX which advertises set-channel as
   * working independent of /raid-channel config action:set. Pattern parity
   * with nudgeStuckPrivateLogUser's $or filter elsewhere in this file.
   */
  function buildMaintenanceConfigQuery() {
    return {
      $or: [
        { raidChannelId: { $ne: null } },
        { "announcements.maintenanceEarly.channelId": { $ne: null } },
        { "announcements.maintenanceCountdown.channelId": { $ne: null } },
      ],
    };
  }

  async function runMaintenanceTick(client) {
    const now = new Date();
    const match = getMaintenanceSlotForNow(now);
    if (!match) return;
    const { slot, group } = match;
    const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const dayKey = vn.toISOString().slice(0, 10);
    const tickKey = `${dayKey}:${slot.key}`;
    const subdocKey = group === "early" ? "maintenanceEarly" : "maintenanceCountdown";
    const dedupField =
      group === "early" ? "lastMaintenanceEarlyKey" : "lastMaintenanceCountdownKey";

    let configs;
    try {
      configs = await GuildConfig.find(buildMaintenanceConfigQuery()).lean();
    } catch (err) {
      console.error("[maintenance] config load failed:", err?.message || err);
      return;
    }
    if (!configs.length) return;

    for (const cfg of configs) {
      const announcements = getAnnouncementsConfig(cfg);
      const conf = announcements[subdocKey];
      // Cheap pre-filter on lean doc - cuts the obvious no-ops before the
      // atomic claim round-trip. The claim itself re-checks both fields
      // server-side so this isn't trusted as the source of truth.
      if (!conf.enabled) continue;
      if (cfg[dedupField] === tickKey) continue;

      const guild = client.guilds.cache.get(cfg.guildId);
      if (!guild) continue;
      // channelId override falls back to monitor channel - same parity
      // with weekly-reset and stuck-nudge announcement types. Both null
      // (e.g. guild matched on the OTHER group's override but THIS group
      // has neither override nor monitor) → skip silently rather than
      // throwing on a null fetch.
      const targetChannelId = conf.channelId || cfg.raidChannelId;
      if (!targetChannelId) continue;
      let channel = guild.channels.cache.get(targetChannelId);
      if (!channel) {
        try {
          channel = await guild.channels.fetch(targetChannelId);
        } catch {
          continue;
        }
      }
      if (!channel) continue;

      // Per-guild broadcast language for the maintenance variant pick. The
      // pool array itself comes from the locale tree, so a guild on JP/EN
      // gets its own variant pool while the legacy VN default stays
      // identical to before this migration.
      const guildLang = await getGuildLanguage(cfg.guildId, { GuildConfigModel: GuildConfig });
      const content = pickMaintenanceVariant(slot.key, guildLang);
      if (!content) continue;

      // Atomic claim via findOneAndUpdate filter: stamps dedup ONLY if
      // (a) this exact tickKey hasn't been stamped yet AND (b) the group
      // is still enabled. `$ne: false` matches both `true` AND missing
      // (legacy guilds with the subdoc absent before defaults applied).
      // Combines 3 prior race classes into one Mongo round-trip:
      //   - Race opt-out: admin runs /raid-announce action:off between
      //     `find` and post → claim filter rejects, skip silently.
      //   - Cross-tick double-post: 2 ticks read tickKey=null, both
      //     post, both stamp → claim filter only lets one pass.
      //   - In-process tick overlap: separate `tickInFlight` flag in
      //     startMaintenanceScheduler is the primary defense; atomic
      //     claim is the belt-and-suspenders backup.
      // Trade-off: post failure AFTER claim loses this slot (next tick
      // sees stamped key, won't retry). Acceptable because Discord post
      // failures are rare + a missed slot is no worse than bot offline at
      // that slot. Same shape as artist-wakeup pre-stamp pattern above.
      let claimed;
      try {
        claimed = await GuildConfig.findOneAndUpdate(
          {
            guildId: cfg.guildId,
            [dedupField]: { $ne: tickKey },
            [`announcements.${subdocKey}.enabled`]: { $ne: false },
          },
          { $set: { [dedupField]: tickKey } },
          { new: true }
        ).lean();
      } catch (err) {
        console.error(
          `[maintenance] guild=${cfg.guildId} slot=${slot.key} claim failed:`,
          err?.message || err
        );
        continue;
      }
      if (!claimed) continue;

      // postChannelAnnouncement catches `channel.send()` failures internally
      // and resolves `null` instead of throwing (see helper at top of file).
      // The atomic claim above already stamped `dedupField`, so a null return
      // here means the slot is GONE this cycle: next tick sees the stamp,
      // skips, and we won't retry until next Wednesday. Log path must
      // distinguish the 2 outcomes so operator has a signal to debug
      // (Discord permission missing, network blip, etc) vs treating a silent
      // failure as a successful fire.
      let sent;
      try {
        sent = await postChannelAnnouncement(
          channel,
          content,
          slot.ttlMs,
          `maintenance ${slot.key}`
        );
      } catch (err) {
        // Defensive: if helper contract changes and starts throwing again,
        // treat as send failure too rather than crashing the tick loop.
        console.error(
          `[maintenance] guild=${cfg.guildId} slot=${slot.key} post threw (dedup stamped, slot lost until next cycle):`,
          err?.message || err
        );
        continue;
      }
      if (sent) {
        console.log(
          `[maintenance] posted guild=${cfg.guildId} group=${group} slot=${slot.key} key=${tickKey}`
        );
      } else {
        console.warn(
          `[maintenance] claimed but send failed guild=${cfg.guildId} slot=${slot.key} (dedup stamped, slot lost until next cycle, check channel permissions or Discord availability)`
        );
      }
    }
  }

  /**
   * Start the 1-min maintenance reminder scheduler. Tick fires regardless
   * of day-of-week; getMaintenanceSlotForNow short-circuits non-Wednesday
   * ticks before any DB query, so 6/7 days a week the tick costs nothing
   * past 2 wall-clock reads. Per-guild gating via maintenanceEarly.enabled /
   * maintenanceCountdown.enabled honors the registry-level toggle from
   * /raid-announce.
   *
   * In-flight guard (parity with startAutoManageDailyScheduler): a single
   * tick under Mongo lag could plausibly outlast the 60s tick interval; a
   * second fire while the first is still running would double-process every
   * guild, post twice in the worst case (atomic claim catches that, but
   * still wastes a Mongo write + log noise). The flag is module-scope, not
   * persisted - process restart resets it, which is fine because a crash
   * mid-tick releases the slot anyway.
   */
  let maintenanceTickInFlight = false;
  function startMaintenanceScheduler(client) {
    maintenanceSchedulerStartedAtMs = Date.now();
    const run = async () => {
      if (maintenanceTickInFlight) {
        console.warn(
          "[maintenance] previous tick still running - skipping this fire to avoid overlap"
        );
        return;
      }
      maintenanceTickInFlight = true;
      try {
        await runMaintenanceTick(client);
      } catch (err) {
        console.error("[maintenance] scheduler tick failed:", err?.message || err);
      } finally {
        maintenanceTickInFlight = false;
      }
    };
    run();
    return setInterval(run, MAINTENANCE_TICK_MS);
  }

  // Phase 3: 24h passive auto-sync for opted-in users. Spreads sync work
  // across the day so the bible footprint stays thin even at scale.
  //
  // Tunables:
  //   - TICK_MS = 30 min (match other schedulers)
  //   - CUTOFF = 24h since last successful sync (Phase 2 piggyback bypasses
  //     this naturally because active users have lastAutoManageSyncAt < 24h)
  //   - BATCH_SIZE = 3 users per tick (math: 48 ticks/day × 3 = 144 user-
  //     syncs/day capacity, covers 100+ users without bursting bible)
  //
  // Killswitch: AUTO_MANAGE_DAILY_DISABLED=true in env → tick early-exits
  // without DB query. Lets ops kill the scheduler without redeploy if
  // bible starts blocking.
  const AUTO_MANAGE_DAILY_TICK_MS = 30 * 60 * 1000;
  const AUTO_MANAGE_DAILY_CUTOFF_MS = 24 * 60 * 60 * 1000;
  const AUTO_MANAGE_DAILY_BATCH_SIZE = 3;
  let autoManageSchedulerStartedAtMs = null;

  /**
   * For each user whose sync tick produced an all-"Logs not enabled"
   * outcome, post a channel-level nudge tagging the user in the first
   * reachable guild surface they're a member of (`stuck-nudge` override
   * channel or fallback monitor channel). Uses `User.lastPrivateLogNudgeAt`
   * for 7-day dedup so a stuck user isn't tagged each 30-min tick.
   *
   * Channel resolution policy: iterate guilds that have either a monitor
   * channel or an explicit stuck-nudge override, find the first one where
   * the user is a member (cache-first, skip if cold). If no guild in bot's
   * cache has the user, skip the nudge entirely - we don't have a public
   * surface to nudge on.
   */
  async function nudgeStuckPrivateLogUser(client, discordId) {
    if (!client) return;
    let userDoc;
    try {
      userDoc = await User.findOne({ discordId }).select("lastPrivateLogNudgeAt").lean();
    } catch (err) {
      console.warn(`[auto-manage daily] nudge lookup failed user=${discordId}:`, err?.message || err);
      return;
    }
    if (!userDoc) return;
    const now = Date.now();
    if (userDoc.lastPrivateLogNudgeAt && now - userDoc.lastPrivateLogNudgeAt < PRIVATE_LOG_NUDGE_DEDUP_MS) {
      return; // still within 7-day dedup window
    }

    let configs;
    try {
      configs = await GuildConfig.find({
        $or: [
          { raidChannelId: { $ne: null } },
          { "announcements.stuckPrivateLogNudge.channelId": { $ne: null } },
        ],
      }).lean();
    } catch (err) {
      console.warn(`[auto-manage daily] nudge config load failed user=${discordId}:`, err?.message || err);
      return;
    }

    for (const cfg of configs) {
      const announcements = getAnnouncementsConfig(cfg);
      if (!announcements.stuckPrivateLogNudge.enabled) continue; // disabled per guild
      const guild = client.guilds.cache.get(cfg.guildId);
      if (!guild) continue;
      // Members cache can be cold on large guilds; skip non-member hits
      // without doing a full fetch (cheap path). If bot is deployed in a
      // single guild (Traine's setup), cache-hit is the common case.
      if (!guild.members.cache.has(discordId)) continue;
      // Channel override via /raid-announce set-channel; fallback to monitor
      // channel if no override set.
      const targetChannelId = announcements.stuckPrivateLogNudge.channelId || cfg.raidChannelId;
      let channel = guild.channels.cache.get(targetChannelId);
      if (!channel) {
        try {
          channel = await guild.channels.fetch(targetChannelId);
        } catch {
          continue;
        }
      }
      if (!channel) continue;

      // Nudge body explicitly mentions <@discordId> to pull that user's
      // attention - render in the target user's per-user lang per the
      // "bot pings X => X's lang" rule. Other channel members see it
      // incidentally; the audience-of-one (the user with the stuck
      // private log) is who needs to act on it.
      const targetLang = await getUserLanguage(discordId, { UserModel: User });
      // Phase 6: attach a "Switch to Local Sync" button so stuck users
      // have an in-place CTA instead of having to type the
      // /raid-auto-manage action:local-on flow. customId encodes the
      // target user id so the click handler verifies clicker.id ===
      // target before flipping (don't let a random member opt someone
      // else into local-sync). discord.js builders required inline -
      // schedulers factory doesn't ship them as deps; one-time cost.
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
      const switchBtn = new ButtonBuilder()
        .setCustomId(`stuck-nudge:switch-to-local:${discordId}`)
        .setLabel(t("announcements.stuck-nudge.switchButtonLabel", targetLang))
        .setEmoji("🌐")
        .setStyle(ButtonStyle.Primary);
      const components = [new ActionRowBuilder().addComponents(switchBtn)];
      const sent = await postChannelAnnouncement(
        channel,
        t("announcements.stuck-nudge.body", targetLang, { discordId }),
        PRIVATE_LOG_NUDGE_TTL_MS,
        "auto-manage private-log nudge",
        components
      );
      if (sent) {
        try {
          await User.findOneAndUpdate({ discordId }, { $set: { lastPrivateLogNudgeAt: now } });
        } catch (err) {
          console.warn(
            `[auto-manage daily] nudge dedup stamp failed user=${discordId}:`,
            err?.message || err
          );
        }
        return; // only post in one guild per nudge
      }
    }
  }

  async function runAutoManageDailyTick(client) {
    if (process.env.AUTO_MANAGE_DAILY_DISABLED === "true") return;

    const cutoff = Date.now() - AUTO_MANAGE_DAILY_CUTOFF_MS;
    // Mongo-side filter so we don't pull every opted-in user into memory:
    //   - autoManageEnabled true (opted in)
    //   - has at least one account (Mongo "accounts.0 exists" pattern)
    //   - never synced (null) OR last success > 24h ago
    //
    // Sort by `lastAutoManageAttemptAt` ascending - NOT `lastAutoManageSyncAt`.
    // Why: stuck users (Cloudflare 403 forever, private-log forever) never
    // advance `lastAutoManageSyncAt`, so sorting by sync-time would pick
    // the same 3 stuck users every tick and starve everyone behind them
    // (Codex round 27 finding #1). Sorting by attempt-time lets stuck users
    // rotate out: each attempt stamps `lastAutoManageAttemptAt` (success
    // path, opt-out race, save-fail catch - all stamp it), so after a tick
    // they're no longer stalest by attempt and the next-stalest user gets
    // a turn. Fair coverage even when some users perma-fail.
    const candidates = await User.find({
      autoManageEnabled: true,
      "accounts.0": { $exists: true },
      $or: [
        { lastAutoManageSyncAt: null },
        { lastAutoManageSyncAt: { $lt: cutoff } },
      ],
    })
      .sort({ lastAutoManageAttemptAt: 1 })
      .limit(AUTO_MANAGE_DAILY_BATCH_SIZE)
      .select("discordId")
      .lean();

    if (candidates.length === 0) return;

    const weekResetStart = weekResetStartMs();
    // Counters split by actual outcome so the operator log never lies about
    // "synced N" when really nothing got refreshed (Codex round 27 #3):
    //   - syncedCount: at least 1 char succeeded → lastAutoManageSyncAt
    //     stamped. The metric operator actually cares about for "is the
    //     scheduler doing useful work?".
    //   - attemptedOnlyCount: bible was hit but no char succeeded (all
    //     errored, or user opted out mid-flight) → only attempt stamped,
    //     no fresh data. Burns quota with zero progress.
    //   - skippedCount: didn't hit bible (cooldown / in-flight / opt-out
    //     before gather / no roster).
    //   - failedCount: caught throw - usually bible HTTP error or save
    //     blowup.
    let syncedCount = 0;
    let attemptedOnlyCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const { discordId } of candidates) {
      // Reuse the same slot as Phase 2 piggyback + manual action:sync so
      // we never double-fire bible against the same user across paths.
      // Acquire failure (cooldown / in-flight) → skip silently, retry next
      // tick.
      const guard = await acquireAutoManageSyncSlot(discordId);
      if (!guard.acquired) {
        skippedCount += 1;
        continue;
      }
      let bibleHit = false;
      try {
        const seedDoc = await User.findOne({ discordId });
        if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
          // Roster removed between query + slot acquire - skip cleanly.
          skippedCount += 1;
          continue;
        }
        // Opt-out race: user could have hit action:off between the candidate
        // query and the slot acquire. Skip silently - no point hitting bible
        // for a user who explicitly opted out.
        if (!seedDoc.autoManageEnabled) {
          skippedCount += 1;
          continue;
        }
        ensureFreshWeek(seedDoc);
        const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart);
        bibleHit = true;
        // Outcome bucket for THIS user, decided inside saveWithRetry and
        // read after to drive the right counter increment. Default
        // "attempted-only" - apply branches override to "synced" when at
        // least one char actually fetched without error.
        let outcome = "attempted-only";
        // Capture the latest report ref so the post-save stuck-user check
        // can read it (saveWithRetry may run its closure multiple times on
        // VersionError; we want the last committed pass).
        let latestReport = null;
        await saveWithRetry(async () => {
          const fresh = await User.findOne({ discordId });
          if (!fresh || !Array.isArray(fresh.accounts) || fresh.accounts.length === 0) return;
          ensureFreshWeek(fresh);
          // Same opt-out re-check as Phase 2 piggyback (Codex round 26 #1):
          // user can toggle off during the long bible HTTP. Stamp attempt
          // anyway so cooldown reflects the burned quota.
          if (!fresh.autoManageEnabled) {
            fresh.lastAutoManageAttemptAt = Date.now();
            await fresh.save();
            return;
          }
          const report = applyAutoManageCollected(fresh, weekResetStart, collected);
          latestReport = report;
          const now = Date.now();
          fresh.lastAutoManageAttemptAt = now;
          if (report.perChar.some((c) => !c.error)) {
            fresh.lastAutoManageSyncAt = now;
            outcome = "synced";
          }
          await fresh.save();
        });
        if (outcome === "synced") syncedCount += 1;
        else attemptedOnlyCount += 1;

        // Stuck private-log detection: every char in this user's roster
        // returned "Logs not enabled" from bible. Post a 7-day-deduped
        // channel nudge (not DM - Traine wanted the same surface as the
        // weekly-reset nudge: public channel, not private DM).
        // Skip if the save closure never produced a report (e.g. mid-flight
        // opt-out short-circuited before apply).
        if (
          latestReport &&
          latestReport.perChar.length > 0 &&
          latestReport.perChar.every((c) => isPublicLogDisabledError(c.error))
        ) {
          await nudgeStuckPrivateLogUser(client, discordId);
        }
      } catch (err) {
        failedCount += 1;
        // Codex round 26 #2 parity: bible burned quota but save threw. Stamp
        // attempt so the slot's 15-min cooldown still kicks in for next tick.
        if (bibleHit) {
          await stampAutoManageAttempt(discordId);
        }
        console.warn(
          `[auto-manage daily] user ${discordId} sync failed:`,
          err?.message || err
        );
      } finally {
        releaseAutoManageSyncSlot(discordId);
      }
    }

    console.log(
      `[auto-manage daily] tick: ${candidates.length} candidate(s) · synced ${syncedCount} · attempted-only ${attemptedOnlyCount} · skipped ${skippedCount} · failed ${failedCount}`
    );
  }

  /**
   * Start the 24h passive auto-sync scheduler for /raid-auto-manage opted-in
   * users. Tick cadence (30 min) matches the other schedulers so operator
   * has one mental model. Per-tick batch size + per-user slot acquire keep
   * bible footprint thin even at scale - see runAutoManageDailyTick header.
   *
   * In-flight guard: a single tick can plausibly run > 30 min under bible
   * outage (sequential users × sequential chars × up to 10 paginated logs ×
   * 15s timeout per HTTP). `setInterval` doesn't block the next fire on a
   * slow callback, so without the guard, two ticks could overlap and double
   * bible traffic - defeating the per-tick batch cap (Codex round 27 #2).
   * The guard is module-scope (not persisted) - process restart resets it,
   * which is fine: a crash during a tick releases the slot anyway.
   *
   * Returns the interval handle. Caller doesn't need to track it for the
   * normal lifetime - process exit kills the timer.
   */
  // ---------------------------------------------------------------------------
  // Side-task reset scheduler
  // ---------------------------------------------------------------------------
  //
  // Auto-resets `completed=false` on per-character side tasks once their
  // cycle boundary passes. Runs on a dedicated 30-min interval so a global
  // AUTO_MANAGE_DAILY_DISABLED killswitch doesn't strand side-tasks in
  // "completed forever" state (side tasks are user-tracked chores, unrelated
  // to bible auto-sync).
  //
  // Cycle boundaries:
  //   - daily   = 10:00 UTC (= 17:00 VN, LA daily reset moment)
  //   - weekly  = `weekResetStartMs()` (Wed 10:00 UTC = 17:00 VN, same as
  //               raid weekly reset - on Wednesdays the daily and weekly
  //               boundaries collide at the same instant by design)
  //
  // Reset is bulk via `updateMany` with named arrayFilter so a tick costs
  // one round-trip regardless of user count. The pre-filter on the outer
  // query short-circuits when no document has any expired side task, so
  // the steady state is essentially a no-op.

  const SIDE_TASK_RESET_TICK_MS = 30 * 60 * 1000;
  let sideTaskSchedulerStartedAtMs = null;
  let sideTaskTickInFlight = false;

  function dailyResetStartMs(now = new Date()) {
    // Snap to the most recent 10:00 UTC boundary that has passed.
    // LA's daily reset is 17:00 VN = 10:00 UTC (UTC+7 offset).
    const cursor = new Date(now.getTime());
    if (cursor.getUTCHours() < 10) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return Date.UTC(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth(),
      cursor.getUTCDate(),
      10, 0, 0, 0
    );
  }

  async function resetExpiredSideTasks(now = new Date()) {
    const dailyStart = dailyResetStartMs(now);
    const weeklyStart = weekResetStartMs(now);

    const dailyResult = await User.updateMany(
      {
        "accounts.characters.sideTasks": {
          $elemMatch: { reset: "daily", lastResetAt: { $lt: dailyStart } },
        },
      },
      {
        $set: {
          "accounts.$[].characters.$[].sideTasks.$[task].completed": false,
          "accounts.$[].characters.$[].sideTasks.$[task].lastResetAt": dailyStart,
        },
      },
      {
        arrayFilters: [
          { "task.reset": "daily", "task.lastResetAt": { $lt: dailyStart } },
        ],
      }
    );

    const weeklyResult = await User.updateMany(
      {
        "accounts.characters.sideTasks": {
          $elemMatch: { reset: "weekly", lastResetAt: { $lt: weeklyStart } },
        },
      },
      {
        $set: {
          "accounts.$[].characters.$[].sideTasks.$[task].completed": false,
          "accounts.$[].characters.$[].sideTasks.$[task].lastResetAt": weeklyStart,
        },
      },
      {
        arrayFilters: [
          { "task.reset": "weekly", "task.lastResetAt": { $lt: weeklyStart } },
        ],
      }
    );

    const sharedDailyResult = await User.updateMany(
      {
        "accounts.sharedTasks": {
          $elemMatch: { reset: "daily", lastResetAt: { $lt: dailyStart } },
        },
      },
      {
        $set: {
          "accounts.$[].sharedTasks.$[task].completed": false,
          "accounts.$[].sharedTasks.$[task].completedAt": null,
          "accounts.$[].sharedTasks.$[task].lastResetAt": dailyStart,
        },
      },
      {
        arrayFilters: [
          { "task.reset": "daily", "task.lastResetAt": { $lt: dailyStart } },
        ],
      }
    );

    const sharedWeeklyResult = await User.updateMany(
      {
        "accounts.sharedTasks": {
          $elemMatch: { reset: "weekly", lastResetAt: { $lt: weeklyStart } },
        },
      },
      {
        $set: {
          "accounts.$[].sharedTasks.$[task].completed": false,
          "accounts.$[].sharedTasks.$[task].completedAt": null,
          "accounts.$[].sharedTasks.$[task].lastResetAt": weeklyStart,
        },
      },
      {
        arrayFilters: [
          { "task.reset": "weekly", "task.lastResetAt": { $lt: weeklyStart } },
        ],
      }
    );

    return {
      dailyModified: dailyResult?.modifiedCount || 0,
      weeklyModified: weeklyResult?.modifiedCount || 0,
      sharedDailyModified: sharedDailyResult?.modifiedCount || 0,
      sharedWeeklyModified: sharedWeeklyResult?.modifiedCount || 0,
      dailyStart,
      weeklyStart,
    };
  }

  function startSideTaskResetScheduler() {
    sideTaskSchedulerStartedAtMs = Date.now();
    const run = async () => {
      if (sideTaskTickInFlight) return;
      sideTaskTickInFlight = true;
      try {
        const report = await resetExpiredSideTasks();
        if (
          report.dailyModified > 0 ||
          report.weeklyModified > 0 ||
          report.sharedDailyModified > 0 ||
          report.sharedWeeklyModified > 0
        ) {
          console.log(
            `[side-task reset] daily=${report.dailyModified} weekly=${report.weeklyModified} sharedDaily=${report.sharedDailyModified} sharedWeekly=${report.sharedWeeklyModified}`
          );
        }
      } catch (err) {
        console.error("[side-task reset] tick failed:", err?.message || err);
      } finally {
        sideTaskTickInFlight = false;
      }
    };
    run();
    return setInterval(run, SIDE_TASK_RESET_TICK_MS);
  }

  let dailyTickInFlight = false;
  function startAutoManageDailyScheduler(client) {
    autoManageSchedulerStartedAtMs = Date.now();
    const run = async () => {
      if (dailyTickInFlight) {
        console.warn(
          "[auto-manage daily] previous tick still running - skipping this fire to avoid overlap"
        );
        return;
      }
      dailyTickInFlight = true;
      try {
        await runAutoManageDailyTick(client);
      } catch (err) {
        console.error("[auto-manage daily] scheduler tick failed:", err?.message || err);
      } finally {
        dailyTickInFlight = false;
      }
    };
    run();
    return setInterval(run, AUTO_MANAGE_DAILY_TICK_MS);
  }

  return {
    AUTO_CLEANUP_TICK_MS,
    AUTO_MANAGE_DAILY_TICK_MS,
    MAINTENANCE_TICK_MS,
    MAINTENANCE_DAY_VN,
    MAINTENANCE_HOUR_VN,
    MAINTENANCE_MINUTE_VN,
    ARTIST_QUIET_START_HOUR_VN,
    ARTIST_QUIET_END_HOUR_VN,
    postChannelAnnouncement,
    getTargetCleanupSlotKey,
    getTargetVNDayKey,
    getCurrentVNHour,
    isInArtistQuietHours,
    hasReachedArtistWakeupBoundary,
    buildCleanupNoticePreview,
    pickBedtimeNoticeContent,
    pickWakeupNoticeContent,
    getMaintenanceSlotForNow,
    pickMaintenanceVariant,
    buildMaintenancePreview,
    buildMaintenanceConfigQuery,
    getMaintenanceSlotConfigSnapshot,
    startRaidChannelScheduler,
    startAutoManageDailyScheduler,
    startMaintenanceScheduler,
    startSideTaskResetScheduler,
    dailyResetStartMs,
    resetExpiredSideTasks,
    getAutoCleanupSchedulerStartedAtMs: () => autoCleanupSchedulerStartedAtMs,
    getAutoManageSchedulerStartedAtMs: () => autoManageSchedulerStartedAtMs,
    getMaintenanceSchedulerStartedAtMs: () => maintenanceSchedulerStartedAtMs,
    getSideTaskSchedulerStartedAtMs: () => sideTaskSchedulerStartedAtMs,
  };
}

module.exports = {
  createRaidSchedulerService,
};
