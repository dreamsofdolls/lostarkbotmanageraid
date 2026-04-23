const User = require("./schema/user");
const { saveWithRetry } = require("./schema/user");
const GuildConfig = require("./schema/guildConfig");
const { RAID_REQUIREMENTS } = require("./models/Raid");

const WEEKLY_ANNOUNCEMENT_TTL_MS = 30 * 60 * 1000; // marker sits 30 min before self-delete

const RAID_GROUP_KEYS = Object.keys(RAID_REQUIREMENTS);

/**
 * ISO-week string for a given moment, computed in UTC.
 * Used both as the reset cursor ("has this week been processed?") and as the
 * trigger comparison ("is the stored cursor behind the current target week?").
 */
function getWeekKey(date = new Date()) {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNumber);

  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

/**
 * Target week key for reset purposes. The "reset moment" is Wednesday 10:00 UTC,
 * which is Wednesday 17:00 Vietnam time (UTC+7). Before that moment in a given
 * ISO week, the target is the PREVIOUS ISO week (so users stay on last week's
 * key). At or after that moment, the target is the current ISO week. This lets
 * catch-up runs on non-Wednesdays still pick up any users whose cursor lags the
 * current target - the window missing bug.
 */
function getTargetResetKey(now = new Date()) {
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  // Sunday (0) is ISO day 7 - part of the same ISO week as the preceding
  // Wednesday, so treat it as "after this week's reset moment".
  const passedResetMoment =
    utcDay === 0 ||
    utcDay > 3 ||
    (utcDay === 3 && utcHour >= 10);

  if (passedResetMoment) return getWeekKey(now);

  const earlier = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return getWeekKey(earlier);
}

function clearCharacterProgress(character) {
  const assignedRaids = character.assignedRaids || {};
  for (const raidKey of RAID_GROUP_KEYS) {
    if (!assignedRaids[raidKey]) continue;
    const gateKeys = Object.keys(assignedRaids[raidKey] || {}).filter((gate) => /^G\d+$/i.test(gate));
    for (const gate of gateKeys) {
      if (!assignedRaids[raidKey][gate]) continue;
      assignedRaids[raidKey][gate].completedDate = null;
    }
  }

  const tasks = Array.isArray(character.tasks) ? character.tasks : [];
  for (const task of tasks) {
    task.completions = 0;
    task.completionDate = null;
  }

  character.assignedRaids = assignedRaids;
  character.tasks = tasks;
}

async function resetWeekly(now = new Date()) {
  const targetKey = getTargetResetKey(now);

  const staleUsers = await User.find({ weeklyResetKey: { $ne: targetKey } }).select("_id discordId").lean();
  let modifiedCount = 0;

  for (const { discordId } of staleUsers) {
    try {
      const didModify = await saveWithRetry(async () => {
        const user = await User.findOne({ discordId });
        if (!user || user.weeklyResetKey === targetKey) return false;

        for (const account of user.accounts || []) {
          for (const character of account.characters || []) {
            clearCharacterProgress(character);
          }
        }
        user.weeklyResetKey = targetKey;
        await user.save();
        return true;
      });
      if (didModify) modifiedCount += 1;
    } catch (error) {
      console.error(
        `[weekly-reset] Failed to reset discordId=${discordId}: ${error.message}`
      );
    }
  }

  return {
    skipped: false,
    resetKey: targetKey,
    matchedCount: staleUsers.length,
    modifiedCount,
  };
}

/**
 * For each guild with a configured monitor channel, post a weekly-reset
 * announcement tagged with the current target week key and self-delete
 * after WEEKLY_ANNOUNCEMENT_TTL_MS. Dedup per guild via
 * `GuildConfig.lastWeeklyAnnouncementKey` so a catch-up tick in the same
 * ISO week doesn't re-announce. Silent failure path - bot without
 * Send Messages perm or deleted channel just skips without throwing.
 */
async function postWeeklyResetAnnouncements(client, targetKey) {
  if (!client || !targetKey) return;
  let configs;
  try {
    configs = await GuildConfig.find({
      raidChannelId: { $ne: null },
      $or: [
        { lastWeeklyAnnouncementKey: null },
        { lastWeeklyAnnouncementKey: { $ne: targetKey } },
      ],
    }).lean();
  } catch (err) {
    console.warn("[weekly-reset] announcement config load failed:", err?.message || err);
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

    try {
      const sent = await channel.send({
        content:
          "Tuần mới đến rồi nhỉ~ Artist vừa reset progress raid tuần này cho các cậu, giờ chỉ việc làm lại từ đầu thôi. Chúc các cậu tuần raid vui vẻ nha, biển báo này Artist cuỗm đi sau 30 phút.",
      });
      await GuildConfig.findOneAndUpdate(
        { guildId: cfg.guildId },
        { $set: { lastWeeklyAnnouncementKey: targetKey } }
      );
      setTimeout(() => sent.delete().catch(() => {}), WEEKLY_ANNOUNCEMENT_TTL_MS);
    } catch (err) {
      console.warn(
        `[weekly-reset] announcement post failed guild=${cfg.guildId}:`,
        err?.message || err
      );
    }
  }
}

function startWeeklyResetJob(client) {
  const run = async () => {
    try {
      const result = await resetWeekly();
      if (result.matchedCount > 0) {
        console.log(
          `[weekly-reset] resetKey=${result.resetKey} matched=${result.matchedCount} modified=${result.modifiedCount}`
        );
      }
      // Post the channel announcement AFTER reset so members reading the
      // announcement already see fresh progress. Runs on every tick but
      // short-circuits at the per-guild dedup key - no spam during
      // catch-up ticks within the same ISO week.
      await postWeeklyResetAnnouncements(client, result.resetKey);
    } catch (error) {
      console.error("[weekly-reset] Failed to reset raid completion:", error.message);
    }
  };

  run().catch(() => {});
  return setInterval(run, 30 * 60 * 1000);
}

/**
 * Freshen a hydrated User document to the current target reset key.
 * If the user's weeklyResetKey lags the current target (i.e. last-passed
 * Wed 10:00 UTC = Wed 17:00 Vietnam time), clear every character's
 * gate-completedDate and task counters and bump the key. Idempotent:
 * when the key already matches the target, this is a no-op and returns false.
 *
 * Call this at the start of every write path (/raid-set, /add-roster)
 * so a command cannot silently set data that the weekly reset job is
 * about to wipe on its next 30-minute tick.
 */
function ensureFreshWeek(user, now = new Date()) {
  if (!user) return false;
  const targetKey = getTargetResetKey(now);
  if (user.weeklyResetKey === targetKey) return false;

  for (const account of user.accounts || []) {
    for (const character of account.characters || []) {
      clearCharacterProgress(character);
    }
  }
  user.weeklyResetKey = targetKey;
  return true;
}

module.exports = {
  resetWeekly,
  startWeeklyResetJob,
  getWeekKey,
  getTargetResetKey,
  ensureFreshWeek,
  clearCharacterProgress,
};
