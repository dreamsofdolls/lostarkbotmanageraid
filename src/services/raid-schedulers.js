"use strict";

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
  const PRIVATE_LOG_NUDGE_TTL_MS = 30 * 60 * 1000; // stuck-user nudge sits 30 min before self-delete
  const PRIVATE_LOG_NUDGE_DEDUP_MS = 7 * 24 * 60 * 60 * 1000; // 7-day per-user dedup
  const AUTO_CLEANUP_TICK_MS = 30 * 60 * 1000;
  let autoCleanupSchedulerStartedAtMs = null;

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
  async function postChannelAnnouncement(channel, content, ttlMs, logTag = "announcement") {
    let sent = null;
    try {
      sent = await channel.send({ content });
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
   * Variant pool per cleanup-count bucket. Random pick at fire time gives
   * the channel a more lived-in tone instead of a single repeating line.
   * Buckets sized empirically: 0 = silent channel (idle marker), 1-5 = a
   * few stragglers, 6-20 = typical night of posting, 21+ = backlog.
   *
   * Voice: "cắm tạm biển / nghỉ / sủi" instead of the earlier "tự biến /
   * tự dọn" phrasing per Traine - the self-delete mechanic reads more
   * naturally as Artist physically placing a sign, resting a bit, then
   * slipping away with it. No stage-direction italics per
   * feedback_no_stage_directions.
   */
  const CLEANUP_NOTICE_VARIANTS_BY_BUCKET = {
    empty: [
      "Ghé qua thấy chỗ này sạch tinh rồi nhé~ Artist cắm tạm biển ngồi nghỉ 5 phút xong sủi đi thôi, các cậu cứ tiếp tục post clear bình thường nha.",
      "Hmm, các cậu dọn sẵn sạch gọn quá~ Artist đặt biển ở đây nghỉ tay 5 phút rồi sủi, biển cũng đi theo Artist luôn.",
      "Chỗ này vẫn ngăn nắp ghê~ Artist cắm biển cảm ơn, tranh thủ nghỉ 5 phút rồi sủi đi làm việc khác, các cậu cứ tự nhiên.",
    ],
    trivial: [
      "Thu gom **N** mẩu tin, nhẹ nhàng thôi mà~ Artist cắm tạm biển nghỉ 5 phút xong sủi đi tiếp nhé.",
      "Ok, **N** tin nhỏ xinh Artist đã dọn gọn. Biển báo cắm tạm đây thôi, 5 phút xong hai đứa cùng sủi.",
      "Có **N** mẩu lặt vặt thôi, Artist xử lý xong liền~ Cắm biển ngồi 5 phút rồi sủi, các cậu cứ post clear tiếp nha.",
    ],
    normal: [
      "Đến ca dọn rồi nhé, Artist vừa quét **N** tin~ Cắm biển ngồi nghỉ 5 phút xong sủi đi thôi, các cậu cứ post clear bình thường.",
      "Đúng nhịp dọn dẹp đây~ **N** tin đã được Artist thu gọn. Biển cắm tạm ở đây nghỉ 5 phút rồi sủi nha.",
      "Xong một lượt, **N** tin được Artist dọn gọn ghẽ. Artist cắm biển nghỉ chút 5 phút, xong sủi đi, các cậu cứ tiếp tục.",
    ],
    heavy: [
      "Oáp... **N** tin phải dọn này, Artist hụt hơi thật~ Cắm biển xuống nghỉ 5 phút đã, xong Artist với biển cùng sủi nha.",
      "Nhiều rác thật đấy, **N** tin lận~ Artist vừa dọn gọn xong, cắm tạm biển ngồi thở 5 phút rồi sủi, các cậu post sôi nổi ghê.",
      "Artist tăng ca dọn **N** tin luôn, mệt ghê~ Cắm biển nghỉ 5 phút rồi sủi đi, các cậu cứ tiếp tục post clear thoải mái nha.",
    ],
  };

  /**
   * Resolve the notice text for a cleanup tick outcome. Bucketing sized
   * empirically - 0 triggers the "idle heartbeat" pool, 1-5 the "trivial"
   * pool, 6-20 the "normal" pool, 21+ the "heavy backlog" pool. Random
   * pick within the bucket gives variety without falling out of tone.
   */
  function pickCleanupNoticeContent(deleted) {
    let bucket;
    if (deleted <= 0) bucket = "empty";
    else if (deleted <= 5) bucket = "trivial";
    else if (deleted <= 20) bucket = "normal";
    else bucket = "heavy";
    const pool = CLEANUP_NOTICE_VARIANTS_BY_BUCKET[bucket];
    const picked = pool[Math.floor(Math.random() * pool.length)];
    return picked.replace(/\*\*N\*\*/g, `**${deleted}**`);
  }

  // Ordered bucket metadata for rendering the cleanup preview. Pulled out
  // of the pool so preview listing stays stable order (empty -> heavy) and
  // the label text isn't duplicated in two places.
  const CLEANUP_NOTICE_BUCKETS_ORDERED = [
    { key: "empty", label: "Sạch sẵn (0 tin)" },
    { key: "trivial", label: "Nhẹ (1-5 tin)" },
    { key: "normal", label: "Vừa (6-20 tin)" },
    { key: "heavy", label: "Nhiều (21+ tin)" },
  ];

  /**
   * Build the /raid-announce show preview text for the hourly-cleanup
   * type from CLEANUP_NOTICE_VARIANTS_BY_BUCKET so admins see every
   * variant Artist might actually post. Each variant is truncated to
   * VARIANT_MAX so the whole field stays under Discord's 1024-char
   * field value cap - there are up to 4 buckets * 3 variants = 12
   * lines plus 4 bucket headers, so ~70 chars/variant fits comfortably.
   */
  function buildCleanupNoticePreview() {
    // 60 chars/variant keeps total under Discord's 1024-char field cap
    // across 4 buckets × 3 variants + 4 bucket headers + intro line.
    const VARIANT_MAX = 60;
    const lines = ["Random pick mỗi lần fire theo lượng rác:"];
    for (const { key, label } of CLEANUP_NOTICE_BUCKETS_ORDERED) {
      const pool = CLEANUP_NOTICE_VARIANTS_BY_BUCKET[key] || [];
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
    const targetKey = getTargetCleanupSlotKey();
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
      if (cfg.lastAutoCleanupKey === targetKey) continue; // already done for this VN half-hour slot
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
        const cleanupNoticeEnabled = getAnnouncementsConfig(cfg).hourlyCleanupNotice.enabled;
        if (cleanupNoticeEnabled) {
          const noticeContent = pickCleanupNoticeContent(deleted);
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
   * `lastAutoCleanupKey` so no-op ticks are cheap.
   */
  function startRaidChannelScheduler(client) {
    autoCleanupSchedulerStartedAtMs = Date.now();
    const run = () =>
      runAutoCleanupTick(client).catch((err) => {
        console.error("[raid-channel] scheduler tick failed:", err?.message || err);
      });
    run();
    return setInterval(run, AUTO_CLEANUP_TICK_MS);
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

      const sent = await postChannelAnnouncement(
        channel,
        `<@${discordId}> nhắc khẽ nhé~ Roster cậu đã bật auto-manage nhưng hiện tại tất cả char đều là private log, Artist không sync được data đâu. Vào https://lostark.bible/me/logs bật **Show on Profile** cho char cần sync giúp tớ nha. Biển báo này Artist cuỗm đi sau 30 phút.`,
        PRIVATE_LOG_NUDGE_TTL_MS,
        "auto-manage private-log nudge"
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
        // Opt-out race: user could have bấm action:off between the candidate
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
        // channel nudge (not DM - Traine: nudge như weekly reset ý).
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
    postChannelAnnouncement,
    getTargetCleanupSlotKey,
    buildCleanupNoticePreview,
    startRaidChannelScheduler,
    startAutoManageDailyScheduler,
    getAutoCleanupSchedulerStartedAtMs: () => autoCleanupSchedulerStartedAtMs,
    getAutoManageSchedulerStartedAtMs: () => autoManageSchedulerStartedAtMs,
  };
}

module.exports = {
  createRaidSchedulerService,
};
