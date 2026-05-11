"use strict";

const { t, getGuildLanguage, getUserLanguage } = require("../i18n");
const { DEFAULT_LANGUAGE } = require("../../locales");
const { lookupArray } = require("../../utils/raid/schedule/locale-arrays");
const {
  ARTIST_QUIET_START_HOUR_VN,
  ARTIST_QUIET_END_HOUR_VN,
  getTargetCleanupSlotKey,
  getTargetVNDayKey,
  getTargetDayKeyForLang,
  getCurrentVNHour,
  isInArtistQuietHours,
  isInArtistQuietHoursForLang,
  hasReachedArtistWakeupBoundary,
  hasReachedArtistWakeupBoundaryForLang,
} = require("../../utils/raid/schedule/artist-clock");
const {
  MAINTENANCE_DAY_VN,
  MAINTENANCE_HOUR_VN,
  MAINTENANCE_MINUTE_VN,
  MAINTENANCE_TICK_MS,
  getMaintenanceSlotForNow,
  pickMaintenanceVariant,
  buildMaintenancePreview,
  getMaintenanceSlotConfigSnapshot,
  buildMaintenanceConfigQuery,
} = require("../../utils/raid/schedule/maintenance");
const { dailyResetStartMs } = require("../../utils/raid/schedule/reset-windows");

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
  let maintenanceSchedulerStartedAtMs = null;

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
