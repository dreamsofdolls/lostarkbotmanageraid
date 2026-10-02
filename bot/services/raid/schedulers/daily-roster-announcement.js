"use strict";

const { resolveGuildChannel } = require("../../discord/resolve-guild-channel");
const {
  claimGuildState,
  releaseGuildClaim,
} = require("./guild-state-claim");

const ANNOUNCEMENT_SUBDOC_KEY = "dailyRosterSync";
const DEDUP_FIELD = "lastDailyRosterSyncKey";
const MESSAGE_KEY = "announcements.daily-roster-sync.body";

/**
 * @param {string} targetDayKey VN calendar key being completed.
 * @returns {object} Mongo query matching any registered user still unfinished.
 */
function buildUnfinishedRosterQuery(targetDayKey) {
  return {
    "accounts.0": { $exists: true },
    lastAutoManageDailyFinishedDayKey: { $ne: targetDayKey },
  };
}

/**
 * @param {string} targetDayKey VN calendar key being summarized.
 * @returns {object[]} Mongo aggregation pipeline for bounded scalar totals.
 */
function buildDailyRosterSummaryPipeline(targetDayKey) {
  const isOutcome = (outcomes) => ({
    $cond: [
      { $in: ["$lastAutoManageDailyOutcome", outcomes] },
      1,
      0,
    ],
  });

  return [
    {
      $match: {
        "accounts.0": { $exists: true },
        lastAutoManageDailyFinishedDayKey: targetDayKey,
      },
    },
    {
      $group: {
        _id: null,
        userCount: { $sum: 1 },
        rosterCount: { $sum: { $size: { $ifNull: ["$accounts", []] } } },
        syncedCount: { $sum: isOutcome(["success"]) },
        settledCount: { $sum: isOutcome(["all-private", "no-actionable"]) },
        retryExhaustedCount: { $sum: isOutcome(["retry-exhausted"]) },
      },
    },
    { $project: { _id: 0 } },
  ];
}

/**
 * @param {string} targetDayKey VN calendar key being announced.
 * @returns {object} Mongo query for configured guilds not notified yet.
 */
function buildDailyRosterGuildQuery(targetDayKey) {
  return {
    [DEDUP_FIELD]: { $ne: targetDayKey },
    [`announcements.${ANNOUNCEMENT_SUBDOC_KEY}.enabled`]: { $ne: false },
    $or: [
      { raidChannelId: { $ne: null } },
      { [`announcements.${ANNOUNCEMENT_SUBDOC_KEY}.channelId`]: { $ne: null } },
    ],
  };
}

function createDailyRosterGuildCursor(GuildConfig, targetDayKey) {
  return GuildConfig.find(buildDailyRosterGuildQuery(targetDayKey))
    .select(
      `guildId raidChannelId ${DEDUP_FIELD} `
      + `announcements.${ANNOUNCEMENT_SUBDOC_KEY}`
    )
    .lean()
    .cursor();
}

async function claimDailyRosterAnnouncement({ GuildConfig, cfg, conf, targetDayKey }) {
  return claimGuildState({
    GuildConfig,
    guildId: cfg.guildId,
    guard: {
      [DEDUP_FIELD]: { $ne: targetDayKey },
      [`announcements.${ANNOUNCEMENT_SUBDOC_KEY}.enabled`]: { $ne: false },
      raidChannelId: cfg.raidChannelId ?? null,
      [`announcements.${ANNOUNCEMENT_SUBDOC_KEY}.channelId`]: conf.channelId ?? null,
    },
    claimedState: { [DEDUP_FIELD]: targetDayKey },
  });
}

function buildDailyRosterAnnouncementContent({ t, lang, targetDayKey, summary }) {
  return t(MESSAGE_KEY, lang, {
    targetDayKey,
    userCount: summary.userCount,
    rosterCount: summary.rosterCount,
    syncedCount: summary.syncedCount,
    settledCount: summary.settledCount,
    retryExhaustedCount: summary.retryExhaustedCount,
  });
}

/**
 * @param {object} deps persistence, Discord delivery and localization helpers.
 * @returns {{notifyDailyRosterSync: Function}} Daily aggregate announcer.
 */
function createDailyRosterAnnouncementService({
  User,
  GuildConfig,
  getAnnouncementsConfig,
  getGuildLanguage,
  postChannelAnnouncement,
  t,
  resolveGuildChannelFn = resolveGuildChannel,
}) {
  async function resolveGuildDelivery(client, cfg) {
    const conf = getAnnouncementsConfig(cfg)?.[ANNOUNCEMENT_SUBDOC_KEY];
    if (!conf || conf.enabled === false) return null;
    const channelId = conf.channelId || cfg.raidChannelId;
    if (!channelId) return null;

    const channel = await resolveGuildChannelFn(
      client,
      cfg.guildId,
      channelId
    );
    return channel ? { cfg, conf, channel } : null;
  }

  async function notifyGuild({ delivery, summary, targetDayKey }) {
    const { cfg, conf, channel } = delivery;
    if (cfg[DEDUP_FIELD] === targetDayKey) return false;

    let lang;
    let content;
    try {
      lang = await getGuildLanguage(cfg.guildId, { GuildConfigModel: GuildConfig });
      content = buildDailyRosterAnnouncementContent({
        t,
        lang,
        targetDayKey,
        summary,
      });
    } catch (err) {
      console.warn(
        `[daily-roster-sync] guild=${cfg.guildId} content build failed:`,
        err?.message || err
      );
      return false;
    }

    let claimPrevious;
    try {
      claimPrevious = await claimDailyRosterAnnouncement({
        GuildConfig,
        cfg,
        conf,
        targetDayKey,
      });
    } catch (err) {
      console.error(
        `[daily-roster-sync] guild=${cfg.guildId} claim failed:`,
        err?.message || err
      );
      return false;
    }
    if (!claimPrevious) return false;

    let sent = null;
    let postError = null;
    try {
      sent = await postChannelAnnouncement(
        channel,
        content,
        0,
        "daily roster sync"
      );
    } catch (err) {
      postError = err;
    }

    if (sent) {
      console.log(
        `[daily-roster-sync] posted guild=${cfg.guildId} target=${targetDayKey}`
      );
      return true;
    }

    const claimReleased = await releaseGuildClaim({
      GuildConfig,
      guildId: cfg.guildId,
      claimedState: { [DEDUP_FIELD]: targetDayKey },
      previousState: claimPrevious,
    }, (rollbackError) => console.error(
      `[daily-roster-sync] guild=${cfg.guildId} claim rollback failed:`,
      rollbackError?.message || rollbackError
    ));

    console.warn(
      `[daily-roster-sync] send failed; claim ${claimReleased ? "released" : "not released"} guild=${cfg.guildId} target=${targetDayKey}:`,
      postError?.message || postError || "no message returned"
    );
    return false;
  }

  async function notifyDailyRosterSync(client, dailyContext) {
    const { targetDayKey } = dailyContext;
    let notifiedCount = 0;
    let cursor = null;
    try {
      cursor = createDailyRosterGuildCursor(GuildConfig, targetDayKey);
      const iterator = cursor[Symbol.asyncIterator]();
      let next = await iterator.next();
      if (next.done) return { notifiedCount: 0, reason: "no-target-guilds" };

      let firstDelivery = null;
      while (!next.done && !firstDelivery) {
        firstDelivery = await resolveGuildDelivery(client, next.value);
        if (!firstDelivery) next = await iterator.next();
      }
      if (!firstDelivery) {
        return { notifiedCount: 0, reason: "no-deliverable-guilds" };
      }

      const unfinished = await User.exists(buildUnfinishedRosterQuery(targetDayKey));
      if (unfinished) return { notifiedCount: 0, reason: "unfinished" };

      const [summary = null] = await User.aggregate(
        buildDailyRosterSummaryPipeline(targetDayKey)
      );
      if (!summary || Number(summary.userCount) <= 0) {
        return { notifiedCount: 0, reason: "no-rosters" };
      }

      if (await notifyGuild({ delivery: firstDelivery, summary, targetDayKey })) {
        notifiedCount += 1;
      }

      next = await iterator.next();
      while (!next.done) {
        const delivery = await resolveGuildDelivery(client, next.value);
        if (delivery && await notifyGuild({ delivery, summary, targetDayKey })) {
          notifiedCount += 1;
        }
        next = await iterator.next();
      }

      return { notifiedCount, reason: "complete", summary };
    } catch (err) {
      console.error("[daily-roster-sync] guild scan failed:", err?.message || err);
      return { notifiedCount, reason: "guild-scan-failed" };
    } finally {
      if (cursor && typeof cursor.close === "function") {
        try {
          await cursor.close();
        } catch (err) {
          console.warn("[daily-roster-sync] guild cursor close failed:", err?.message || err);
        }
      }
    }
  }

  return { notifyDailyRosterSync };
}

module.exports = {
  ANNOUNCEMENT_SUBDOC_KEY,
  DEDUP_FIELD,
  MESSAGE_KEY,
  buildDailyRosterGuildQuery,
  buildDailyRosterSummaryPipeline,
  buildUnfinishedRosterQuery,
  createDailyRosterAnnouncementService,
};
