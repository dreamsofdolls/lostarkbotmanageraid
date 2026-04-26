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
  const ARTIST_BEDTIME_NOTICE_TTL_MS = 5 * 60 * 1000;
  const ARTIST_WAKEUP_NOTICE_TTL_MS = 10 * 60 * 1000; // longer so 8am members catch it
  // Quiet-hours window in VN local time. Artist skips cleanup + posts no
  // ticks in [QUIET_START_HOUR, QUIET_END_HOUR). Message handling is
  // unaffected - users can still post raid clears in the middle of the
  // night, Artist just doesn't patrol.
  const ARTIST_QUIET_START_HOUR_VN = 3;
  const ARTIST_QUIET_END_HOUR_VN = 8;
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
   * Returns "YYYY-MM-DD" in VN (UTC+7) calendar. Shared dedup key for
   * Artist's once-per-day ceremonial moments (bedtime greeting at 3:00 VN,
   * wake-up + morning sweep at 8:00 VN). Distinct from the half-hour slot
   * key because those ceremonies fire once per calendar day, not per slot.
   */
  function getTargetVNDayKey(now = new Date()) {
    const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return vnTime.toISOString().slice(0, 10);
  }

  /**
   * VN local hour (0-23). Used to decide whether a tick falls inside the
   * quiet-hours window. The calc mirrors getTargetCleanupSlotKey so both
   * helpers stay in lockstep if the UTC offset ever changes.
   */
  function getCurrentVNHour(now = new Date()) {
    const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return vnTime.getUTCHours();
  }

  /**
   * True when the current VN hour is inside Artist's quiet window. The
   * window is half-open: [QUIET_START_HOUR, QUIET_END_HOUR). Hour 8 is NOT
   * quiet - it's the wake-up hour where the catch-up cleanup runs. Hour 2
   * is NOT quiet - the last pre-bedtime cleanup slot at 2:30 runs as usual.
   */
  function isInArtistQuietHours(now = new Date()) {
    const hour = getCurrentVNHour(now);
    return hour >= ARTIST_QUIET_START_HOUR_VN && hour < ARTIST_QUIET_END_HOUR_VN;
  }

  /**
   * True once the VN local clock reaches Artist's 08:00 wake-up boundary.
   * This must NOT be inferred from `!isInArtistQuietHours()` because
   * 00:00-02:59 VN is outside quiet hours too, yet still belongs to the
   * previous day rhythm and must not trigger the wake-up sweep early.
   */
  function hasReachedArtistWakeupBoundary(now = new Date()) {
    return getCurrentVNHour(now) >= ARTIST_QUIET_END_HOUR_VN;
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

  /**
   * Bedtime greeting variants. Fired once per VN calendar day at the first
   * tick inside [3:00, 8:00). Tone: sleepy/peaceful, acknowledges Artist
   * going quiet but reassures that user posts still work. No bucketing -
   * the event is the same shape every day (it's ceremonial, not sweep-
   * scaled), so a flat 3-variant pool keeps the channel from repeating
   * the exact same line two mornings in a row.
   */
  const BEDTIME_NOTICE_VARIANTS = [
    "Khuya rồi, Artist đi ngủ đây nhé~ Từ giờ tới 8h sáng tớ tạm nghỉ, không dọn rác cũng không ồn ào gì. Các cậu cứ post clear bình thường, sáng ra Artist dậy xử lý gọn 1 lần. Biển báo này 5 phút tự cuỗm, chúc cả nhà ngủ ngon nha.",
    "Khuya quá rồi đấy, Artist sập nguồn đây~ Tớ nghỉ tới 8h sáng, kênh này tạm yên tĩnh nhé - các cậu cứ post clear như thường, Artist tỉnh dậy sẽ dọn 1 thể. Ngủ ngon nha, biển báo 5 phút nữa Artist cuỗm theo.",
    "Tới giờ đi ngủ của Artist rồi~ Tớ tắt đèn đây, tạm biệt mọi người đến 8h sáng nha. Yên tâm, raid clear các cậu post vẫn được Artist ghi nhận bình thường, chỉ là biển báo dọn dẹp nghỉ thôi. Biển này 5 phút nữa cũng đi ngủ theo Artist.",
  ];

  /**
   * Wake-up + morning-sweep combined-embed variants. Fires once at the
   * first tick ≥ 8:00 VN. Bucketed by the overnight sweep count because
   * a 0-message night reads differently from a 40-message backlog. Same
   * **N** interpolation pattern as the hourly-cleanup pool.
   *
   * Tone: Artist just woke, is a bit groggy, acknowledges the sweep.
   * Explicitly DIFFERENT pool from the hourly "heavy" bucket so 8 AM
   * doesn't feel like any other heavy cleanup - it's the ceremonial
   * day-start moment.
   */
  const WAKEUP_NOTICE_VARIANTS_BY_BUCKET = {
    empty: [
      "Morning các cậu~ Artist vươn vai dậy đây nè, ghé qua thấy kênh sạch trơn luôn. Không có gì để dọn ngày mới, các cậu ngoan ghê~ Biển báo này 10 phút nữa Artist cuỗm đi.",
      "Tớ dậy rồi nhé~ Đêm qua cả kênh ngủ ngon, không tin nào bỏ lại cho Artist cả. Bắt đầu ngày mới thôi nào, biển báo 10 phút tự đi ngủ tiếp.",
      "Chào buổi sáng các cậu~ Artist mới mở mắt, kênh này sạch như chưa có gì xảy ra. Ngày mới các cậu raid vui nha, biển báo này 10 phút nữa sủi.",
    ],
    trivial: [
      "Morning nha~ Artist vừa dậy, ngó lại thấy đêm qua có **N** tin thôi - tớ dọn luôn 1 thể cho kênh thoáng. Ngày mới raid khoẻ nha, biển báo 10 phút tự cuỗm.",
      "Chào ngày mới các cậu~ Đêm qua có **N** tin nhỏ xinh, Artist dọn trong lúc đánh răng xong rồi. Giờ Artist làm việc bình thường lại, biển này 10 phút nữa đi.",
      "Tớ dậy rồi đây~ Đêm qua chỉ có **N** tin, Artist gom nhanh 1 cái, xong rồi nè. Các cậu tiếp tục post clear thoải mái nha, biển báo 10 phút nữa tự cuỗm.",
    ],
    normal: [
      "Morning các cậu~ Artist vừa mở mắt, ngó sang kênh thấy **N** tin tích đêm qua - dọn 1 thể cho gọn rồi đây. Ngày mới ta lại chiến nha, biển báo 10 phút tự đi.",
      "Artist dậy rồi nè~ Đêm qua **N** tin tích lại, tớ sweep 1 cái cho sạch. Cảm ơn các cậu raid chăm ghê, biển báo này 10 phút nữa cuỗm đi cho khuất mắt.",
      "Chào buổi sáng~ Artist mở app thấy **N** tin đêm qua, gom hết 1 cái cho kênh thoáng. Ngày mới ta làm việc tiếp thôi, biển báo 10 phút nữa Artist mang theo.",
    ],
    heavy: [
      "Oáp... Artist mới dậy đã thấy **N** tin tích đêm qua, các cậu raid dữ dội thật. Tớ dọn 1 thể cho gọn rồi đây, hơi mệt nhưng xong rùi~ Biển báo 10 phút tự đi cho khuất mắt Artist.",
      "Morning... Artist vừa mở mắt đã choáng với **N** tin tích đêm qua, các cậu farm không nghỉ luôn hả~ Tớ sweep 1 thể cho gọn, xong mệt muốn đi ngủ tiếp. Biển báo 10 phút nữa Artist cuỗm đi.",
      "Ớ kìa, Artist mới dậy đã có **N** tin đợi sẵn - các cậu raid xuyên đêm thật hả? Tớ dọn 1 cái cho kênh thoáng, thôi vào việc luôn. Biển báo này 10 phút nữa tự cuỗm nha.",
    ],
  };

  /**
   * Random pick from bedtime pool. Flat list (no bucketing) because the
   * event is always the same - Artist is going quiet, sweep count not
   * relevant at this moment.
   */
  function pickBedtimeNoticeContent() {
    const pool = BEDTIME_NOTICE_VARIANTS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Random pick from the wake-up/morning-sweep pool with the same
   * bucketing as the hourly-cleanup notice (empty / trivial / normal /
   * heavy by sweep count). Separate pool from the hourly one so 8 AM
   * never reuses an "afternoon" line - the ceremonial tone matters even
   * when the count matches a regular heavy cleanup.
   */
  function pickWakeupNoticeContent(deleted) {
    let bucket;
    if (deleted <= 0) bucket = "empty";
    else if (deleted <= 5) bucket = "trivial";
    else if (deleted <= 20) bucket = "normal";
    else bucket = "heavy";
    const pool = WAKEUP_NOTICE_VARIANTS_BY_BUCKET[bucket];
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
    const now = new Date();
    const targetKey = getTargetCleanupSlotKey(now);
    const vnDayKey = getTargetVNDayKey(now);
    const quiet = isInArtistQuietHours(now);
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

      // Quiet-hours branch: [3:00, 8:00) VN. Artist does NOT sweep and
      // does NOT post the hourly-cleanup notice. First tick after 3:00
      // posts one bedtime greeting (if enabled + not yet posted today);
      // subsequent quiet-hours ticks are silent no-ops. The dedup key is
      // VN calendar day, not slot, so a bot restart inside [3:00, 8:00)
      // on the same day won't re-fire bedtime.
      if (quiet) {
        if (cfg.lastArtistBedtimeKey === vnDayKey) continue;
        if (!announcements.artistBedtime.enabled) {
          // Bedtime disabled per-guild → still stamp the day key so we
          // don't keep entering this branch; the guild just gets silence.
          await GuildConfig.findOneAndUpdate(
            { guildId: cfg.guildId },
            { $set: { lastArtistBedtimeKey: vnDayKey } }
          );
          continue;
        }
        try {
          const sent = await postChannelAnnouncement(
            channel,
            pickBedtimeNoticeContent(),
            ARTIST_BEDTIME_NOTICE_TTL_MS,
            "raid-channel artist-bedtime"
          );
          if (sent) {
            await GuildConfig.findOneAndUpdate(
              { guildId: cfg.guildId },
              { $set: { lastArtistBedtimeKey: vnDayKey } }
            );
            console.log(
              `[raid-channel] artist-bedtime guild=${cfg.guildId} day=${vnDayKey}`
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
      if (hasReachedArtistWakeupBoundary(now) && cfg.lastArtistWakeupKey !== vnDayKey) {
        try {
          const { deleted, skippedOld } = await cleanupRaidChannelMessages(channel);
          await GuildConfig.findOneAndUpdate(
            { guildId: cfg.guildId },
            {
              $set: {
                lastArtistWakeupKey: vnDayKey,
                lastAutoCleanupKey: targetKey,
              },
            }
          );
          console.log(
            `[raid-channel] artist-wakeup guild=${cfg.guildId} day=${vnDayKey} deleted=${deleted} skippedOld=${skippedOld}`
          );
          if (announcements.artistWakeup.enabled) {
            await postChannelAnnouncement(
              channel,
              pickWakeupNoticeContent(deleted),
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

  // ---------------------------------------------------------------------------
  // Maintenance reminder scheduler (LA VN weekly maintenance: Wednesday 14:00 VN)
  // ---------------------------------------------------------------------------
  // Lost Ark VN bảo trì cố định Wednesday 14:00 VN. Hard-coded ở đây thay vì
  // configurable per guild because (a) the schedule is tied to the publisher
  // not the server, (b) a single global truth avoids drift if multiple guilds
  // ever join, and (c) keeping the value as constants means changing the
  // schedule is a one-line PR if LA VN ever shifts the boundary.
  const MAINTENANCE_DAY_VN = 3; // 0=Sun, 3=Wed
  const MAINTENANCE_HOUR_VN = 14;
  const MAINTENANCE_MINUTE_VN = 0;
  const MAINTENANCE_TICK_MS = 60 * 1000; // 1-min cadence to catch every slot
  // TTL per group: early reminders linger 30 phút (members may scroll back),
  // countdown reminders self-delete faster because the next slot is right behind
  // them. T-1m TTL is shortest because the server is about to be down anyway.
  const MAINTENANCE_TTL_EARLY_MS = 30 * 60 * 1000;
  const MAINTENANCE_TTL_COUNTDOWN_MS = 10 * 60 * 1000;
  const MAINTENANCE_TTL_FINAL_MS = 5 * 60 * 1000;
  let maintenanceSchedulerStartedAtMs = null;

  // Slot definitions: minutesBefore = phút trước boundary 14:00 VN. Two
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

  // Variant pool per slot. 3 variants each so a server doesn't read the
  // same line two weeks in a row. Tone progression: early = checklist nhắc
  // (shop solo / event / paradise / key hell), countdown = đếm ngược dồn
  // dập, final = chốt thoát game. `@here` baked into the string for the 2
  // milestone slots per Traine - bot only needs to send content as-is.
  // No em-dash anywhere per feedback_no_emdash; LA term game (shop solo,
  // event, paradise, key hell, raid, clear) preserved per Traine guidance.
  const MAINTENANCE_VARIANTS = {
    "T-3h": [
      "@here Nee các cậu~ 3 tiếng nữa là tới giờ bảo trì rồi đó. Tranh thủ làm nốt mấy việc nha: shop solo tuần này còn gì hay không thì lượn 1 vòng ngó thử, event đang chạy ai chưa nhận quà thì lấy kẻo phí, paradise với key hell ai chưa đi thì gấp lên đi nốt. Artist nhắc trước cho khỏi quên thôi, biển báo này 30 phút nữa Artist cuỗm đi nha.",
      "@here Còn 3 tiếng nữa thôi là server bảo trì các cậu ơi~ Mấy việc tuần này nhớ nha: shop solo còn món nào hay thì sắm nhanh, event đang chạy quà nhận luôn cho gọn, paradise với key hell chưa đi thì giờ là lúc thích hợp đó. Artist nhắc đầu giờ thôi, biển báo 30 phút nữa Artist cuỗm theo.",
      "@here 3 giờ đồng hồ nữa thì bảo trì rồi nhé các cậu. Artist nhắc cho đỡ quên: shop solo tuần này có gì thì rinh về, event đang chạy quà còn dư thì nhặt nốt, paradise với key hell ai còn nợ thì giải quyết luôn cho nhẹ đầu. Biển báo này 30 phút nữa Artist gói lại nha.",
    ],
    "T-2h": [
      "Hai tiếng nữa thì bảo trì rồi nhé các cậu~ Artist nhắc lại cho chắc: shop solo, event, paradise, key hell mấy món hôm nay nhớ chốt nốt nha. Biển báo này 30 phút nữa Artist cuỗm đi.",
      "Còn 2 tiếng cuối trong giờ làm việc đó~ Ai còn dở shop solo, event, paradise hay key hell thì gấp lên nha, tránh để sát giờ mới làm thì không kịp. Biển báo Artist gói lại sau 30 phút.",
      "2 tiếng nữa server bảo trì rồi các cậu~ Artist ngó thấy nhiều cậu vẫn online nên nhắc thêm 1 lần: shop solo / event / paradise / key hell mấy món tuần này nhớ làm cho gọn nha. Biển báo cuỗm đi sau 30 phút.",
    ],
    "T-1h": [
      "@here Còn 1 tiếng nữa là tới giờ bảo trì rồi nhé các cậu! Lần nhắc cuối trong giờ làm việc đây, shop solo, event, paradise, key hell ai còn dở thì gấp lên hoàn thành nha, qua 14:00 là cooldown reset hết. Artist gói biển báo này lại sau 30 phút.",
      "@here 60 phút cuối rồi đó các cậu~ Shop solo, event, paradise, key hell ai chưa xong thì giờ là hạn chót thật rồi nha. Artist nhắc gấp đây, biển báo cuỗm sau 30 phút.",
      "@here Một tiếng nữa thôi là bảo trì các cậu ơi! Artist giục lần cuối: shop solo, event, paradise, key hell mấy món tuần này ai còn nợ thì gấp lên giải quyết, qua giờ là không quay lại được đâu. Biển báo này 30 phút nữa Artist cuỗm đi.",
    ],
    "T-15m": [
      "15 phút cuối rồi đó các cậu~ Còn dở việc gì thì cố nốt đi nha, sắp tới giờ bảo trì rồi. Artist đếm ngược cùng các cậu đây, biển báo này 10 phút nữa cuỗm đi.",
      "Một khắc đồng hồ nữa thôi là server tắt nhé~ Ai đang trong raid thì cố clear cho xong, không thì thoát game cho lành. Artist đếm ngược, biển báo 10 phút sau Artist cuỗm theo.",
      "Còn 15 phút nữa thôi các cậu~ Sắp tới giờ rồi đó, gói gọn lại đi nhé. Artist đứng đếm ngược cùng các cậu, biển báo này Artist gói lại sau 10 phút.",
    ],
    "T-10m": [
      "10 phút nữa thôi các cậu ơi~ Đang dở gì thì xong nốt nhanh đi nha, đừng để sát giờ. Artist đếm tiếp, biển báo 10 phút nữa cuỗm theo.",
      "Còn 10 phút thôi đó~ Ai đang ở thành phố thì giờ cũng đừng vào raid mới làm gì, tốn tiền vào ra. Artist nhắc nhẹ, biển báo cuỗm sau 10 phút.",
      "Đếm ngược 10 phút cuối nha các cậu. Sắp tới giờ Artist với server cùng nghỉ rồi đó. Biển báo này Artist mang theo sau 10 phút.",
    ],
    "T-5m": [
      "5 phút cuối rồi nhé các cậu~ Đăng xuất gọn ghẽ thôi, đừng cố raid kẻo tự nhiên mất tiến độ giữa chừng. Artist đếm tiếp, biển báo 10 phút nữa cuỗm đi.",
      "Còn 5 phút thôi đó~ Ai đang trong raid thì cứ thoát ra cho lành, vào dở mất công. Artist gần ngủ trưa rồi đây, biển báo cuỗm sau 10 phút.",
      "Đếm ngược 5 phút cuối các cậu ơi! Server sắp tắt rồi nha, ai online thì chuẩn bị thoát game cho gọn. Biển báo này 10 phút nữa Artist mang đi.",
    ],
    "T-1m": [
      "1 phút cuối rồi nha các cậu! Thoát game thôi cho lành, đang dở gì cũng đành dừng đây, server tắt là mất hết đấy. Hẹn gặp lại sau bảo trì nha~",
      "60 giây cuối các cậu ơi! Lưu rồi thoát thôi, đừng tiếc nuối cố thêm gì, tới rồi là tới rồi. Artist đi nghỉ đây, hẹn các cậu sau bảo trì~",
      "Một phút thôi đó! Thoát game gấp đi các cậu~ Artist với server cùng đi nghỉ giờ này, biển báo này 5 phút nữa cũng tự đi luôn. Hẹn gặp lại nha.",
    ],
  };

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
  function pickMaintenanceVariant(slotKey) {
    const pool = MAINTENANCE_VARIANTS[slotKey];
    if (!pool || pool.length === 0) return "";
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
      const pool = MAINTENANCE_VARIANTS[s.key] || [];
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
    const vnDayKey = vn.toISOString().slice(0, 10);
    const tickKey = `${vnDayKey}:${slot.key}`;
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

      const content = pickMaintenanceVariant(slot.key);
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
    getAutoCleanupSchedulerStartedAtMs: () => autoCleanupSchedulerStartedAtMs,
    getAutoManageSchedulerStartedAtMs: () => autoManageSchedulerStartedAtMs,
    getMaintenanceSchedulerStartedAtMs: () => maintenanceSchedulerStartedAtMs,
  };
}

module.exports = {
  createRaidSchedulerService,
};
