/**
 * scheduling.js
 *
 * Announcement timing + scheduler-tick math extracted from bot/commands.js.
 * Factory pattern because some calculations depend on scheduler state
 * (auto-cleanup tick, auto-manage daily tick) that's only known after
 * the scheduler service is wired up at compose-root boot. The compose
 * root passes getter functions that close over the lazy `let` bindings
 * so the lookups defer until call-time.
 *
 * Used by: bot/commands.js (compose root), handlers/raid/announce.js,
 * handlers/raid/channel.js (via re-export from commands).
 */

function createSchedulingHelpers({
  // Pure dep - just the registry-key list
  announcementSubdocKeys,
  // Resolvers for timestamps + interval values. Wrapped in getters so the
  // factory can be built before the lazy `let` bindings in bot/commands.js
  // get assigned by createRaidSchedulerService at boot.
  resolveWeeklyResetStarted,
  resolveWeeklyResetTickMs,
  resolveAutoCleanupStarted,
  resolveAutoCleanupTickMs,
  resolveAutoManageStarted,
  resolveAutoManageDailyTickMs,
  resolveMaintenanceStarted,
  resolveMaintenanceTickMs,
  resolveMaintenanceSlotConfig,
}) {

  /**
   * Load (or lazily initialize) the `announcements` subdoc for a guild.
   * Legacy guilds that existed before the schema field landed may have
   * `cfg.announcements = undefined`; schema defaults kick in on save but
   * not on `.lean()` reads, so callers must normalize. Returns a plain
   * object with every type's config populated with defaults.
   */
  function getAnnouncementsConfig(cfg) {
    const raw = cfg?.announcements || {};
    const normalized = {};
    for (const subdocKey of announcementSubdocKeys()) {
      const sub = raw[subdocKey] || {};
      normalized[subdocKey] = {
        enabled: sub.enabled !== false, // default true when missing
        channelId: sub.channelId || null,
      };
    }
    return normalized;
  }
  
  /**
   * Next scheduler wake-up time for an interval job that started at
   * `startedAtMs` and runs every `intervalMs`. We intentionally derive this
   * from the scheduler's REAL boot phase instead of wall-clock boundaries,
   * because `setInterval(30m)` keeps the process-start phase forever
   * (:17/:47, :03/:33, etc).
   */
  function nextIntervalTickMs(startedAtMs, intervalMs, now = new Date()) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      return null;
    }
    if (nowMs < startedAtMs) return startedAtMs;
    const elapsed = nowMs - startedAtMs;
    const ticksElapsed = Math.floor(elapsed / intervalMs) + 1;
    return startedAtMs + (ticksElapsed * intervalMs);
  }
  
  /**
   * Wall-clock eligibility boundary for announcement types whose natural
   * trigger is tied to a calendar boundary. This is NOT always the same as
   * the next actual scheduler check because the bot polls every 30 minutes
   * from its boot phase.
   */
  function nextAnnouncementEligibleBoundaryMs(typeKey, now = new Date()) {
    const nowMs = now.getTime();
    if (typeKey === "weekly-reset") {
      const candidate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        10, 0, 0, 0
      ));
      const utcDay = now.getUTCDay();
      if (utcDay === 3 && now.getUTCHours() < 10) {
        return candidate.getTime();
      }
      // If today is Wed at/after 10 UTC, daysUntilWed collapses to 0 via
      // modulo; promote it to 7 so we advance a full week.
      const daysUntilWed = ((3 - utcDay + 7) % 7) || 7;
      candidate.setUTCDate(candidate.getUTCDate() + daysUntilWed);
      return candidate.getTime();
    }
    if (typeKey === "hourly-cleanup") {
      // Cadence bumped from hourly to 30-min per Traine (Apr 2026). Next
      // eligible boundary is the next :00 or :30 slot, same shape as the
      // stuck-nudge tick boundary below.
      const candidate = new Date(now);
      candidate.setUTCSeconds(0, 0);
      if (candidate.getUTCMinutes() < 30) {
        candidate.setUTCMinutes(30);
      } else {
        candidate.setUTCMinutes(60); // rolls into next hour
      }
      return candidate.getTime();
    }
    if (typeKey === "stuck-nudge") {
      const candidate = new Date(now);
      candidate.setUTCSeconds(0, 0);
      if (candidate.getUTCMinutes() < 30) {
        candidate.setUTCMinutes(30);
      } else {
        candidate.setUTCMinutes(60); // rolls into next hour
      }
      return candidate.getTime();
    }
    if (typeKey === "artist-bedtime" || typeKey === "artist-wakeup") {
      // Bedtime = 3:00 VN = 20:00 UTC previous day. Wake-up = 8:00 VN =
      // 1:00 UTC same day. Compute the next UTC boundary that matches.
      const targetUtcHour = typeKey === "artist-bedtime" ? 20 : 1;
      const candidate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        targetUtcHour, 0, 0, 0
      ));
      if (candidate.getTime() <= nowMs) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
      }
      return candidate.getTime();
    }
    if (typeKey === "maintenance-early" || typeKey === "maintenance-countdown") {
      // Single source of truth: the slot config snapshot from the scheduler
      // module. Boundary day-of-week, UTC hour, minute, and the minutesBefore
      // arrays all come through one resolver - changing the maintenance
      // schedule at the top of raid-schedulers.js automatically flows here.
      const cfg = resolveMaintenanceSlotConfig?.();
      if (!cfg) return null;
      const minutesArr = typeKey === "maintenance-early" ? cfg.earlyMinutes : cfg.countdownMinutes;
      if (!Array.isArray(minutesArr) || minutesArr.length === 0) return null;
      const utcDay = now.getUTCDay();
      const daysToAdd = utcDay === cfg.dayOfWeek
        ? 0
        : (cfg.dayOfWeek - utcDay + 7) % 7;
      const boundary = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + daysToAdd,
        cfg.utcHour, cfg.utcMinute, 0, 0
      ));
      const boundaryMs = boundary.getTime();
      const mocTimes = minutesArr
        .map((m) => boundaryMs - m * 60000)
        .sort((a, b) => a - b);
      for (const t of mocTimes) {
        if (t > nowMs) return t;
      }
      // All fire points this week passed - next eligible is the earliest
      // fire point (largest minutesBefore) of NEXT week's boundary.
      const earliestMinutes = Math.max(...minutesArr);
      return boundaryMs + 7 * 24 * 60 * 60 * 1000 - earliestMinutes * 60000;
    }
    return null; // event-driven
  }
  
  function nextAnnouncementSchedulerCheckMs(typeKey, now = new Date(), schedulerState = {}) {
    const {
      weeklyResetStartedAtMs = resolveWeeklyResetStarted(),
      autoCleanupStartedAtMs = resolveAutoCleanupStarted(),
      autoManageStartedAtMs = resolveAutoManageStarted(),
    } = schedulerState;
    if (typeKey === "weekly-reset") {
      return nextIntervalTickMs(weeklyResetStartedAtMs, resolveWeeklyResetTickMs(), now);
    }
    if (typeKey === "hourly-cleanup") {
      return nextIntervalTickMs(autoCleanupStartedAtMs, resolveAutoCleanupTickMs(), now);
    }
    if (typeKey === "stuck-nudge") {
      return nextIntervalTickMs(autoManageStartedAtMs, resolveAutoManageDailyTickMs(), now);
    }
    if (typeKey === "artist-bedtime" || typeKey === "artist-wakeup") {
      // These piggyback on the auto-cleanup scheduler tick, so the next
      // scheduler check is the same cadence. The dispatch logic inside
      // runAutoCleanupTick decides which path fires at tick time.
      return nextIntervalTickMs(autoCleanupStartedAtMs, resolveAutoCleanupTickMs(), now);
    }
    if (typeKey === "maintenance-early" || typeKey === "maintenance-countdown") {
      const maintenanceStartedAtMs = resolveMaintenanceStarted?.();
      const tickMs = resolveMaintenanceTickMs?.();
      return nextIntervalTickMs(maintenanceStartedAtMs, tickMs, now);
    }
    return null;
  }
  
  function formatDiscordTimestampPair(ms) {
    const unixSec = Math.floor(ms / 1000);
    return `<t:${unixSec}:R> (<t:${unixSec}:F>)`;
  }
  
  function buildAnnouncementWhenItFiresText(typeKey, entry, current, guildCfg, now = new Date(), schedulerState = {}) {
    const {
      autoManageDisabled = process.env.AUTO_MANAGE_DAILY_DISABLED === "true",
    } = schedulerState;
    const triggerLine = `**Trigger:** ${entry?.trigger || "*(not defined)*"}`;
    const dedupLine = `**Dedup:** ${entry?.dedup || "*(none)*"}`;
    const ttlLine = `**Message TTL:** ${entry?.messageTtl || "*(permanent until manual delete)*"}`;
    const effectiveDestinationId = current?.channelId || guildCfg?.raidChannelId || null;
    const lines = [triggerLine];
  
    if (current?.enabled === false) {
      lines.push("**Next check:** Disabled (`/raid-announce action:on` to re-enable)");
      lines.push(dedupLine, ttlLine);
      return lines.join("\n");
    }
  
    if (!effectiveDestinationId) {
      lines.push(
        entry?.channelOverridable
          ? "**Next check:** Waiting for a destination channel (`set-channel` here or `/raid-channel config action:set`)"
          : "**Next check:** Waiting for `/raid-channel config action:set` (monitor channel not configured)"
      );
      lines.push(dedupLine, ttlLine);
      return lines.join("\n");
    }
  
    if (typeKey === "set-greeting" || typeKey === "whisper-ack") {
      lines.push("**Next check:** On-demand (fires when the trigger condition happens; not on a fixed schedule)");
      lines.push(dedupLine, ttlLine);
      return lines.join("\n");
    }
  
    if (typeKey === "hourly-cleanup" && guildCfg?.autoCleanupEnabled !== true) {
      lines.push("**Next check:** Disabled until `/raid-channel config action:schedule-on` is enabled");
      lines.push(dedupLine, ttlLine);
      return lines.join("\n");
    }
  
    // Bedtime + wake-up both ride the auto-cleanup scheduler tick, so
    // they're silent whenever the scheduler itself is off.
    if ((typeKey === "artist-bedtime" || typeKey === "artist-wakeup") && guildCfg?.autoCleanupEnabled !== true) {
      lines.push("**Next check:** Disabled until `/raid-channel config action:schedule-on` is enabled (shares the cleanup scheduler)");
      lines.push(dedupLine, ttlLine);
      return lines.join("\n");
    }
  
    if (typeKey === "stuck-nudge" && autoManageDisabled) {
      lines.push("**Next check:** Disabled by deploy killswitch (`AUTO_MANAGE_DAILY_DISABLED=true`)");
      lines.push(dedupLine, ttlLine);
      return lines.join("\n");
    }
  
    const eligibleBoundaryMs = nextAnnouncementEligibleBoundaryMs(typeKey, now);
    if (eligibleBoundaryMs) {
      lines.push(`**Next eligible boundary:** ${formatDiscordTimestampPair(eligibleBoundaryMs)}`);
    }
  
    const nextCheckMs = nextAnnouncementSchedulerCheckMs(typeKey, now, schedulerState);
    if (nextCheckMs) {
      lines.push(`**Next scheduler check:** ${formatDiscordTimestampPair(nextCheckMs)}`);
    } else {
      lines.push("**Next scheduler check:** After bot startup");
    }
  
    if (typeKey === "weekly-reset") {
      lines.push("**Note:** The announcement posts only if that scheduler pass actually resets at least one user and is still inside the Wed→Thu reset window.");
    } else if (typeKey === "hourly-cleanup") {
      lines.push("**Note:** The notice posts only after this guild's cleanup run completes.");
    } else if (typeKey === "stuck-nudge") {
      lines.push("**Note:** The nudge posts only if that tick finds a user whose logs are private.");
    }
  
    lines.push(dedupLine, ttlLine);
    return lines.join("\n");
  }

  return {
    getAnnouncementsConfig,
    nextIntervalTickMs,
    nextAnnouncementEligibleBoundaryMs,
    nextAnnouncementSchedulerCheckMs,
    formatDiscordTimestampPair,
    buildAnnouncementWhenItFiresText,
  };
}

module.exports = { createSchedulingHelpers };
