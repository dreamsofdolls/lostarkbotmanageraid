/**
 * utils/raid/schedule/scheduling.js
 * Announcement timing + scheduler-tick math extracted from
 * bot/commands.js. Factory pattern because some calculations depend on
 * scheduler state (auto-cleanup tick, auto-manage daily tick) that's
 * only known after the scheduler service is wired at compose-root boot.
 * The announcement-config reader has no such dependency, so it has its own
 * factory and the schedulers can use it before these helpers exist.
 * Used by: bot/commands.js, handlers/raid/announce.js,
 * handlers/raid/channel.js (via re-export from commands).
 */

const { weeklyResetStartMs } = require("./reset-windows");

/**
 * Build the reader that normalizes a guild's `announcements` subdoc.
 * @param {{announcementSubdocKeys: function, announcementSubdocDefaultEnabled?: function}} deps
 * @returns {function(object): object} getAnnouncementsConfig
 */
function createAnnouncementsConfigReader({
  announcementSubdocKeys,
  announcementSubdocDefaultEnabled = () => true,
}) {
  /**
   * Load (or lazily initialize) the `announcements` subdoc for a guild.
   * Legacy guilds that existed before the schema field landed may have
   * `cfg.announcements = undefined`; schema defaults kick in on save but
   * not on `.lean()` reads, so callers must normalize. Returns a plain
   * object with every type's config populated with defaults.
   */
  return function getAnnouncementsConfig(cfg) {
    const raw = cfg?.announcements || {};
    const normalized = {};
    for (const subdocKey of announcementSubdocKeys()) {
      const sub = raw[subdocKey] || {};
      normalized[subdocKey] = {
        enabled: typeof sub.enabled === "boolean"
          ? sub.enabled
          : announcementSubdocDefaultEnabled(subdocKey),
        channelId: sub.channelId || null,
      };
    }
    return normalized;
  };
}

/**
 * Build the scheduling-helpers service from injected scheduler-state
 * getters. All resolve* fns are getters (not values): a scheduler's start
 * time is only known once it has started.
 * @param {object} deps - see destructure inside
 * @returns {{getAnnouncementsConfig: function, nextIntervalTickMs: function, nextAnnouncementEligibleBoundaryMs: function, nextAnnouncementSchedulerCheckMs: function, formatDiscordTimestampPair: function, buildAnnouncementWhenItFiresText: function}}
 */
function createSchedulingHelpers({
  // Pure dep - just the registry-key list
  announcementSubdocKeys,
  announcementSubdocDefaultEnabled = () => true,
  // Resolvers for timestamps + interval values. Getters, because a
  // scheduler's start time is only known once it has started.
  resolveWeeklyResetStarted,
  resolveWeeklyResetTickMs,
  resolveAutoCleanupStarted,
  resolveAutoCleanupTickMs,
  resolveAutoManageStarted,
  resolveAutoManageDailyTickMs,
  resolveMaintenanceStarted,
  resolveMaintenanceTickMs,
  resolveMaintenanceSlotConfig,
  resolveWorldEventStarted = () => null,
  resolveWorldEventTickMs = () => null,
  resolveNextWorldEventReminderBoundary = () => null,
}) {

  const getAnnouncementsConfig = createAnnouncementsConfigReader({
    announcementSubdocKeys,
    announcementSubdocDefaultEnabled,
  });
  
  /**
   * Next scheduler wake-up time for an interval job that started at
   * `startedAtMs` and runs every `intervalMs`. This is derived
   * from the scheduler's REAL boot phase instead of wall-clock boundaries,
   * because `setInterval(30m)` preserves the process-start phase
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
  
  function nextWeeklyResetBoundaryMs(now) {
    return weeklyResetStartMs(now) + 7 * 24 * 60 * 60 * 1000;
  }

  function nextHalfHourBoundaryMs(now) {
    const candidate = new Date(now);
    candidate.setUTCSeconds(0, 0);
    candidate.setUTCMinutes(candidate.getUTCMinutes() < 30 ? 30 : 60);
    return candidate.getTime();
  }

  function nextDailyUtcBoundaryMs(now, targetUtcHour) {
    const candidate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      targetUtcHour, 0, 0, 0
    ));
    if (candidate.getTime() <= now.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate.getTime();
  }

  function nextMaintenanceBoundaryMs(now, minutesKey) {
    // Single source of truth: the slot config snapshot from the scheduler
    // module. Changing that config automatically flows into this preview.
    const cfg = resolveMaintenanceSlotConfig?.();
    if (!cfg) return null;
    const minutesArr = cfg[minutesKey];
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
    const futureFirePoint = minutesArr
      .map((minutesBefore) => boundaryMs - minutesBefore * 60000)
      .sort((a, b) => a - b)
      .find((timestampMs) => timestampMs > now.getTime());
    if (futureFirePoint !== undefined) return futureFirePoint;

    // All fire points this week passed - next eligible is the earliest
    // fire point (largest minutesBefore) of NEXT week's boundary.
    const earliestMinutes = Math.max(...minutesArr);
    return boundaryMs + 7 * 24 * 60 * 60 * 1000 - earliestMinutes * 60000;
  }

  const cleanupSchedulerCheck = ({ now, schedulerState }) => nextIntervalTickMs(
    schedulerState.autoCleanupStartedAtMs,
    resolveAutoCleanupTickMs(),
    now
  );
  const maintenanceSchedulerCheck = ({ now }) => nextIntervalTickMs(
    resolveMaintenanceStarted?.(),
    resolveMaintenanceTickMs?.(),
    now
  );
  const cleanupScheduleDisabled = ({ guildCfg }) => guildCfg?.autoCleanupEnabled !== true;

  const announcementScheduleRules = Object.freeze({
    "weekly-reset": {
      eligibleBoundary: nextWeeklyResetBoundaryMs,
      schedulerCheck: ({ now, schedulerState }) => nextIntervalTickMs(
        schedulerState.weeklyResetStartedAtMs,
        resolveWeeklyResetTickMs(),
        now
      ),
      note: "The announcement posts only if that scheduler pass actually resets at least one user and is still inside the Wed→Thu reset window.",
    },
    "hourly-cleanup": {
      eligibleBoundary: nextHalfHourBoundaryMs,
      schedulerCheck: cleanupSchedulerCheck,
      disabledWhen: cleanupScheduleDisabled,
      disabledText: "Disabled until `/raid-channel config action:schedule-on` is enabled",
      note: "The notice posts only after this guild's cleanup run completes.",
    },
    "stuck-nudge": {
      eligibleBoundary: nextHalfHourBoundaryMs,
      schedulerCheck: ({ now, schedulerState }) => nextIntervalTickMs(
        schedulerState.autoManageStartedAtMs,
        resolveAutoManageDailyTickMs(),
        now
      ),
      disabledWhen: ({ autoManageDisabled }) => autoManageDisabled,
      disabledText: "Disabled by deploy killswitch (`AUTO_MANAGE_DAILY_DISABLED=true`)",
      note: "The nudge posts only if that tick finds a user whose logs are private.",
    },
    "artist-bedtime": {
      eligibleBoundary: (now) => nextDailyUtcBoundaryMs(now, 20),
      schedulerCheck: cleanupSchedulerCheck,
      disabledWhen: cleanupScheduleDisabled,
      disabledText: "Disabled until `/raid-channel config action:schedule-on` is enabled (shares the cleanup scheduler)",
    },
    "artist-wakeup": {
      eligibleBoundary: (now) => nextDailyUtcBoundaryMs(now, 1),
      schedulerCheck: cleanupSchedulerCheck,
      disabledWhen: cleanupScheduleDisabled,
      disabledText: "Disabled until `/raid-channel config action:schedule-on` is enabled (shares the cleanup scheduler)",
    },
    "maintenance-early": {
      eligibleBoundary: (now) => nextMaintenanceBoundaryMs(now, "earlyMinutes"),
      schedulerCheck: maintenanceSchedulerCheck,
    },
    "maintenance-countdown": {
      eligibleBoundary: (now) => nextMaintenanceBoundaryMs(now, "countdownMinutes"),
      schedulerCheck: maintenanceSchedulerCheck,
    },
    "world-event-reminder": {
      eligibleBoundary: (now) => resolveNextWorldEventReminderBoundary(now),
      schedulerCheck: ({ now, schedulerState }) => nextIntervalTickMs(
        schedulerState.worldEventStartedAtMs,
        resolveWorldEventTickMs(),
        now
      ),
      note: "This high-frequency reminder is opt-in and combines Chaos Gate + Field Boss into one Sunday post when their spawn time matches.",
    },
    "set-greeting": { onDemand: true },
    "whisper-ack": { onDemand: true },
  });

  /**
   * Wall-clock eligibility boundary for announcement types whose natural
   * trigger is tied to a calendar boundary. This is NOT always the same as
   * the next actual scheduler check because the bot polls every 30 minutes
   * from its boot phase.
   */
  function nextAnnouncementEligibleBoundaryMs(typeKey, now = new Date()) {
    return announcementScheduleRules[typeKey]?.eligibleBoundary?.(now) ?? null;
  }
  
  /**
   * Next time the scheduler actually wakes up to consider firing this
   * announcement type. Differs from `nextAnnouncementEligibleBoundaryMs`
   * because the bot's tick phase (30-min) drifts off wall-clock
   * boundaries · the eligible boundary is the calendar moment, this is
   * the next scheduler tick at-or-after.
   * @param {string} typeKey - announcement type key
   * @param {Date} [now=new Date()] - test clock
   * @param {object} [schedulerState={}] - optional overrides for testing
   * @returns {number|null} next-check ms or null for event-driven types
   */
  function nextAnnouncementSchedulerCheckMs(typeKey, now = new Date(), schedulerState = {}) {
    const {
      weeklyResetStartedAtMs = resolveWeeklyResetStarted(),
      autoCleanupStartedAtMs = resolveAutoCleanupStarted(),
      autoManageStartedAtMs = resolveAutoManageStarted(),
      worldEventStartedAtMs = resolveWorldEventStarted(),
    } = schedulerState;
    const rule = announcementScheduleRules[typeKey];
    if (!rule?.schedulerCheck) return null;
    return rule.schedulerCheck({
      now,
      schedulerState: {
        weeklyResetStartedAtMs,
        autoCleanupStartedAtMs,
        autoManageStartedAtMs,
        worldEventStartedAtMs,
      },
    });
  }
  
  function formatDiscordTimestampPair(ms) {
    const unixSec = Math.floor(ms / 1000);
    return `<t:${unixSec}:R> (<t:${unixSec}:F>)`;
  }
  
  /**
   * Build the multi-line "when does this fire" body for /raid-announce
   * show. Returns markdown text combining trigger/dedup/TTL (static from
   * registry) with next eligible boundary + next scheduler check
   * (dynamic from scheduler state). Handles disabled/missing-channel
   * fall-throughs so the embed always shows something actionable.
   * @param {string} typeKey
   * @param {object} entry - registry entry for typeKey
   * @param {{enabled?: boolean, channelId?: string}} current - guild's current cfg for this type
   * @param {object} guildCfg - full guild config (for raidChannelId fallback + autoCleanupEnabled)
   * @param {Date} [now=new Date()]
   * @param {object} [schedulerState={}]
   * @returns {string} markdown body for the embed field
   */
  function buildAnnouncementWhenItFiresText(typeKey, entry, current, guildCfg, now = new Date(), schedulerState = {}) {
    const {
      autoManageDisabled = process.env.AUTO_MANAGE_DAILY_DISABLED === "true",
    } = schedulerState;
    const triggerLine = `**Trigger:** ${entry?.trigger || "*(not defined)*"}`;
    const dedupLine = `**Dedup:** ${entry?.dedup || "*(none)*"}`;
    const ttlLine = `**Message TTL:** ${entry?.messageTtl || "*(permanent until manual delete)*"}`;
    const effectiveDestinationId = current?.channelId || guildCfg?.raidChannelId || null;
    // Every variant opens with the trigger and ends with the dedup and TTL lines.
    const finish = (...body) => [triggerLine, ...body, dedupLine, ttlLine].join("\n");
  
    if (current?.enabled === false) {
      return finish("**Next check:** Disabled (`/raid-announce action:on` to re-enable)");
    }
  
    if (!effectiveDestinationId) {
      return finish(
        entry?.channelOverridable
          ? "**Next check:** Waiting for a destination channel (`set-channel` here or `/raid-channel config action:set`)"
          : "**Next check:** Waiting for `/raid-channel config action:set` (monitor channel not configured)"
      );
    }
  
    const scheduleRule = announcementScheduleRules[typeKey];
    if (scheduleRule?.onDemand) {
      return finish("**Next check:** On-demand (fires when the trigger condition happens; not on a fixed schedule)");
    }

    if (scheduleRule?.disabledWhen?.({ guildCfg, autoManageDisabled })) {
      return finish(`**Next check:** ${scheduleRule.disabledText}`);
    }
  
    const lines = [];
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
  
    if (scheduleRule?.note) {
      lines.push(`**Note:** ${scheduleRule.note}`);
    }
  
    return finish(...lines);
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

module.exports = { createAnnouncementsConfigReader, createSchedulingHelpers };
