"use strict";

const {
  applyRaidChannelWritePlans,
  resolveRaidChannelWritePlans,
} = require("./channel-monitor-write-plans");
const { resolveParsedRaidUpdate } = require("./channel-monitor-parse-validation");
const {
  buildRaidChannelDmFallbackText,
  buildRaidChannelErrorHint,
  summarizeRaidChannelResults,
} = require("./channel-monitor-results");

const MESSAGE_DEDUP_TTL_MS = 60 * 1000;

function scheduleDetachedTimeout(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function createRaidChannelMessageHandler({
  GuildConfig,
  RAID_REQUIREMENT_MAP,
  UI,
  applyRaidSetBatchForDiscordId,
  applyRaidSetForDiscordId,
  buildRaidChannelMultiResultEmbed,
  checkUserMonitorCooldown,
  clearPendingHint,
  commitUserMonitorActivity,
  getAccessibleAccounts,
  getAnnouncementsConfig,
  getCachedMonitorChannelId,
  getGatesForRaid,
  getUserLanguage,
  hintKey,
  parseRaidMessage,
  postEmptyContentWarning,
  postPersistentHint,
  postSpamWarning,
  t,
  UserModel,
}) {
  const recentlyHandledMessageIds = new Set();

  function shouldIgnoreMessage(message) {
    if (!message) return true;
    if (!message.guildId) return true;
    if (message.author?.bot) return true;
    if (message.system) return true;
    if (message.webhookId) return true;

    const cachedChannelId = getCachedMonitorChannelId(message.guildId);
    return !cachedChannelId || cachedChannelId !== message.channelId;
  }

  function claimMessage(message) {
    if (recentlyHandledMessageIds.has(message.id)) {
      console.warn(
        `[raid-channel] duplicate handler call for message ${message.id} (author=${message.author?.id}) - dropping`
      );
      return false;
    }
    recentlyHandledMessageIds.add(message.id);
    scheduleDetachedTimeout(
      () => recentlyHandledMessageIds.delete(message.id),
      MESSAGE_DEDUP_TTL_MS
    );
    return true;
  }

  async function resolveWhisperAckEnabled(guildId) {
    try {
      const cfg = await GuildConfig.findOne({ guildId })
        .select("announcements.whisperAck")
        .lean();
      return getAnnouncementsConfig(cfg).whisperAck.enabled;
    } catch {
      return true;
    }
  }

  async function sendAggregateDm(message, aggregateEmbed, resultSummary) {
    if (!resultSummary.hasProgress && !resultSummary.hasErrors) return false;
    try {
      await message.author.send({ embeds: [aggregateEmbed] });
      return true;
    } catch (err) {
      console.warn(
        `[raid-channel] DM to ${message.author.tag || message.author.id} failed (DMs disabled?):`,
        err?.message || err
      );
      return false;
    }
  }

  async function maybeSendWhisperAck({ message, authorLang, dmSucceeded }) {
    if (!dmSucceeded) return null;
    const whisperAckEnabled = await resolveWhisperAckEnabled(message.guildId);
    if (!whisperAckEnabled) return null;

    try {
      return message.channel.send({
        content: t("text-parser.whisperAck", authorLang, { userId: message.author.id }),
        allowedMentions: { users: [message.author.id] },
      });
    } catch (err) {
      console.warn("[raid-channel] whisper confirm failed:", err?.message || err);
      return null;
    }
  }

  function scheduleSourceCleanup(message, whisperMsg) {
    scheduleDetachedTimeout(() => {
      message.delete().catch((err) => {
        console.warn("[raid-channel] delete failed (missing Manage Messages?):", err?.message || err);
      });
      if (whisperMsg) {
        whisperMsg.delete().catch(() => {});
      }
    }, 5_000);
  }

  function enqueueDmFallback({ ops, message, results, raidMeta, effectiveGates, authorLang }) {
    const fallbackText = buildRaidChannelDmFallbackText({
      results,
      raidMeta,
      effectiveGates,
      authorLang,
      UI,
      userId: message.author.id,
    });
    ops.push(
      (async () => {
        try {
          const fallback = await message.channel.send({
            content: fallbackText,
            allowedMentions: { users: [message.author.id] },
          });
          scheduleDetachedTimeout(() => fallback.delete().catch(() => {}), 15_000);
        } catch (err) {
          console.warn("[raid-channel] DM fallback post failed:", err?.message || err);
        }
      })()
    );
  }

  async function handleRaidChannelMessage(message) {
    if (shouldIgnoreMessage(message)) return;
    if (!claimMessage(message)) return;

    if (!message.content || !message.content.trim()) {
      await postEmptyContentWarning(message);
      return;
    }

    const userHintKey = hintKey(message.guildId, message.channelId, message.author.id);
    const parsed = parseRaidMessage(message.content);
    if (!parsed) return;

    const cooldown = checkUserMonitorCooldown(message);
    if (!cooldown.accepted) {
      if (cooldown.warn) await postSpamWarning(message);
      message.delete().catch(() => {});
      return;
    }
    commitUserMonitorActivity(message, cooldown.viaException);

    const authorLang = await getUserLanguage(message.author.id, { UserModel });
    const resolvedUpdate = resolveParsedRaidUpdate({
      parsed,
      RAID_REQUIREMENT_MAP,
      getGatesForRaid,
      UI,
      lang: authorLang,
    });
    if (resolvedUpdate.action === "ignore") return;
    if (resolvedUpdate.action === "hint") {
      await postPersistentHint(message, resolvedUpdate.content);
      return;
    }

    const { raidMeta, charNames, statusType, effectiveGates } = resolvedUpdate;
    const writePlans = await resolveRaidChannelWritePlans({
      authorId: message.author.id,
      charNames,
      getAccessibleAccounts,
      logger: console,
    });
    const results = await applyRaidChannelWritePlans({
      plans: writePlans,
      raidMeta,
      statusType,
      effectiveGates,
      applyRaidSetForDiscordId,
      applyRaidSetBatchForDiscordId,
      logger: console,
    });
    const resultSummary = summarizeRaidChannelResults(results);
    if (resultSummary.hadNoRoster) {
      await postPersistentHint(
        message,
        t("text-parser.noRoster", authorLang, { icon: UI.icons.info })
      );
      return;
    }

    const aggregateEmbed = buildRaidChannelMultiResultEmbed({
      results,
      raidMeta,
      gates: effectiveGates,
      statusType,
      guildName: message.guild?.name,
      lang: authorLang,
    });
    const dmSucceeded = await sendAggregateDm(message, aggregateEmbed, resultSummary);
    const ops = [];
    const errorHint = buildRaidChannelErrorHint({
      summary: resultSummary,
      raidMeta,
      authorLang,
      UI,
    });
    if (errorHint) {
      ops.push(postPersistentHint(message, errorHint));
    }

    if (resultSummary.hasProgress) {
      const whisperMsg = await maybeSendWhisperAck({ message, authorLang, dmSucceeded });
      scheduleSourceCleanup(message, whisperMsg);
      if (!resultSummary.hasErrors) {
        ops.push(clearPendingHint(message.channel, userHintKey));
      }
    }

    if (resultSummary.hasProgress && !dmSucceeded) {
      enqueueDmFallback({
        ops,
        message,
        results,
        raidMeta,
        effectiveGates,
        authorLang,
      });
    }
    await Promise.allSettled(ops);
  }

  return {
    handleRaidChannelMessage,
  };
}

module.exports = {
  MESSAGE_DEDUP_TTL_MS,
  createRaidChannelMessageHandler,
};
