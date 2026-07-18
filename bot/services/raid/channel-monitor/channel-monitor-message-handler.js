"use strict";

const {
  applyRaidChannelUpdatePlans,
  resolveRaidChannelWriteBatch,
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
  getRaidLabel,
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

  async function sendAggregateDm(message, aggregateEmbeds, resultSummary) {
    if (!resultSummary.hasProgress && !resultSummary.hasErrors) return false;
    const embeds = Array.isArray(aggregateEmbeds) ? aggregateEmbeds.filter(Boolean) : [];
    if (embeds.length === 0) return false;
    try {
      for (let index = 0; index < embeds.length; index += 10) {
        await message.author.send({ embeds: embeds.slice(index, index + 10) });
      }
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

  function enqueueDmFallback({
    ops,
    message,
    results,
    raidMeta,
    effectiveGates,
    statusType,
    authorLang,
  }) {
    const fallbackText = buildRaidChannelDmFallbackText({
      results,
      raidMeta,
      effectiveGates,
      statusType,
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
      getRaidLabel,
      UI,
      lang: authorLang,
    });
    if (resolvedUpdate.action === "ignore") return;
    if (resolvedUpdate.action === "hint") {
      await postPersistentHint(message, resolvedUpdate.content);
      return;
    }

    const updates = Array.isArray(resolvedUpdate.updates)
      ? resolvedUpdate.updates
      : [{
        raidMeta: resolvedUpdate.raidMeta,
        statusType: resolvedUpdate.statusType,
        effectiveGates: resolvedUpdate.effectiveGates,
      }];
    const { charNames } = resolvedUpdate;
    const writeBatch = await resolveRaidChannelWriteBatch({
      authorId: message.author.id,
      charNames,
      getAccessibleAccounts,
      logger: console,
    });
    if (writeBatch.lookupFailed) {
      await postPersistentHint(
        message,
        [
          t("text-parser.errorSystem", authorLang, {
            icon: UI.icons.warn,
            names: charNames.map((name) => `\`${name}\``).join(", "),
          }),
          t("text-parser.errorRetryNote", authorLang),
        ].join("\n")
      );
      return;
    }
    if (writeBatch.noAccessibleRoster) {
      await postPersistentHint(
        message,
        t("text-parser.noRoster", authorLang, { icon: UI.icons.info })
      );
      return;
    }
    if (writeBatch.missingCharNames.length > 0) {
      await postPersistentHint(
        message,
        [
          t("text-parser.errorNotFound", authorLang, {
            icon: UI.icons.warn,
            names: writeBatch.missingCharNames.map((name) => `\`${name}\``).join(", "),
          }),
          t("text-parser.errorRetryNote", authorLang),
        ].join("\n")
      );
      return;
    }

    const resultGroups = await applyRaidChannelUpdatePlans({
      plans: writeBatch.plans,
      updates,
      applyRaidSetForDiscordId,
      applyRaidSetBatchForDiscordId,
      logger: console,
    });
    const resultSummary = summarizeRaidChannelResults(
      resultGroups.flatMap((group) => group.results)
    );
    if (resultSummary.hadNoRoster) {
      await postPersistentHint(
        message,
        t("text-parser.noRoster", authorLang, { icon: UI.icons.info })
      );
      return;
    }

    const aggregateEmbeds = resultGroups.map((group) =>
      buildRaidChannelMultiResultEmbed({
        results: group.results,
        raidMeta: group.raidMeta,
        gates: group.effectiveGates,
        statusType: group.statusType,
        guildName: message.guild?.name,
        lang: authorLang,
      })
    );
    const dmSucceeded = await sendAggregateDm(message, aggregateEmbeds, resultSummary);
    const ops = [];
    const errorHints = resultGroups
      .map((group) => buildRaidChannelErrorHint({
        summary: summarizeRaidChannelResults(group.results),
        raidMeta: group.raidMeta,
        authorLang,
        UI,
      }))
      .filter(Boolean);
    if (errorHints.length > 0) {
      ops.push(postPersistentHint(message, errorHints.join("\n")));
    }

    if (resultSummary.hasProgress) {
      const whisperMsg = await maybeSendWhisperAck({ message, authorLang, dmSucceeded });
      scheduleSourceCleanup(message, whisperMsg);
      if (!resultSummary.hasErrors) {
        ops.push(clearPendingHint(message.channel, userHintKey));
      }
    }

    if (resultSummary.hasProgress && !dmSucceeded) {
      for (const group of resultGroups) {
        const groupSummary = summarizeRaidChannelResults(group.results);
        if (!groupSummary.hasProgress) continue;
        enqueueDmFallback({
          ops,
          message,
          results: group.results,
          raidMeta: group.raidMeta,
          effectiveGates: group.effectiveGates,
          statusType: group.statusType,
          authorLang,
        });
      }
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
