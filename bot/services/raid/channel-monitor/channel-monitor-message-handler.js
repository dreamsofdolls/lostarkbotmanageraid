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
const MESSAGE_DEDUP_MAX_PERSISTED_IDS = 128;

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
  buildRaidChannelReceiptEmbed,
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
    if (
      !message ||
      !message.guildId ||
      message.author?.bot ||
      message.system ||
      message.webhookId
    ) return true;

    const cachedChannelId = getCachedMonitorChannelId(message.guildId);
    return !cachedChannelId || cachedChannelId !== message.channelId;
  }

  function claimMessageLocally(message) {
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

  async function claimMessageAcrossRuntimes(message) {
    if (typeof GuildConfig?.updateOne !== "function") return true;

    try {
      const result = await GuildConfig.updateOne(
        {
          guildId: message.guildId,
          recentRaidMessageIds: { $ne: message.id },
        },
        {
          $push: {
            recentRaidMessageIds: {
              $each: [message.id],
              $slice: -MESSAGE_DEDUP_MAX_PERSISTED_IDS,
            },
          },
        }
      );
      const modifiedCount = result?.modifiedCount ?? result?.nModified ?? 0;
      if (modifiedCount > 0) return true;

      console.warn(
        `[raid-channel] duplicate runtime delivery for message ${message.id} (author=${message.author?.id}) - dropping`
      );
      return false;
    } catch (err) {
      // Do not take the text monitor offline because the extra idempotency
      // guard failed. Normal raid writes still report their own DB errors.
      console.warn(
        "[raid-channel] distributed message claim failed; continuing with local guard:",
        err?.message || err
      );
      return true;
    }
  }

  async function claimMessage(message) {
    if (!claimMessageLocally(message)) return false;
    return claimMessageAcrossRuntimes(message);
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

  async function sendReceiptDm(message, receiptEmbed) {
    try {
      await message.author.send({ embeds: [receiptEmbed] });
      return true;
    } catch (err) {
      console.warn(
        `[raid-channel] DM to ${message.author.tag || message.author.id} failed (DMs disabled?):`,
        err?.message || err
      );
      return false;
    }
  }

  // The writes are already saved, so a failed re-read must not cost the
  // receipt: it falls back to the roster read before the write.
  async function loadReceiptAccounts(authorId, preWriteAccounts) {
    try {
      return { accounts: await getAccessibleAccounts(authorId), afterWrite: true };
    } catch (err) {
      console.warn(
        `[raid-channel] receipt re-read for ${authorId} failed; using the roster read before the write:`,
        err?.message || err
      );
      return { accounts: preWriteAccounts, afterWrite: false };
    }
  }

  async function maybeSendWhisperAck({ message, authorLang, dmSucceeded }) {
    if (!dmSucceeded) return null;
    const whisperAckEnabled = await resolveWhisperAckEnabled(message.guildId);
    if (!whisperAckEnabled) return null;

    try {
      return await message.channel.send({
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

  function enqueueDmFallback({ ops, message, resultGroups, accounts, authorLang }) {
    const fallbackText = buildRaidChannelDmFallbackText({
      resultGroups,
      accounts,
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

  // Character names as a refusal lists them: each in backticks, comma-separated.
  const formatNameList = (names) => names.map((name) => `\`${name}\``).join(", ");
  const noRosterHint = (lang) => t("text-parser.noRoster", lang, { icon: UI.icons.info });
  // An error line naming the characters it concerns, then the retry note.
  const errorWithRetry = (key, names, lang) => [
    t(key, lang, { icon: UI.icons.warn, names: formatNameList(names) }),
    t("text-parser.errorRetryNote", lang),
  ].join("\n");

  // Why a parsed message writes nothing, in precedence order. A failed access
  // lookup cannot tell which names are missing, and with no roster every name
  // is missing, so the no-roster hint comes before the missing-names list.
  const WRITE_BATCH_REFUSALS = Object.freeze([
    {
      applies: ({ writeBatch }) => writeBatch.lookupFailed,
      hint: ({ charNames, lang }) => errorWithRetry("text-parser.errorSystem", charNames, lang),
    },
    {
      applies: ({ writeBatch }) => writeBatch.noAccessibleRoster,
      hint: ({ lang }) => noRosterHint(lang),
    },
    {
      applies: ({ writeBatch }) => writeBatch.missingCharNames.length > 0,
      hint: ({ writeBatch, lang }) => errorWithRetry("text-parser.errorNotFound", writeBatch.missingCharNames, lang),
    },
  ]);

  async function handleRaidChannelMessage(message) {
    if (shouldIgnoreMessage(message)) return;
    if (!(await claimMessage(message))) return;

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

    const { updates, charNames } = resolvedUpdate;
    const writeBatch = await resolveRaidChannelWriteBatch({
      authorId: message.author.id,
      charNames,
      getAccessibleAccounts,
      logger: console,
    });
    const refusalContext = { writeBatch, charNames, lang: authorLang };
    const refusal = WRITE_BATCH_REFUSALS.find(({ applies }) => applies(refusalContext));
    if (refusal) {
      await postPersistentHint(message, refusal.hint(refusalContext));
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
      await postPersistentHint(message, noRosterHint(authorLang));
      return;
    }

    // Only an empty result set has neither progress nor errors. It gets no
    // reply, and the receipt builder needs at least one raid group.
    if (!resultSummary.hasProgress && !resultSummary.hasErrors) return;

    const receipt = await loadReceiptAccounts(message.author.id, writeBatch.accessibleAccounts);
    const receiptEmbed = buildRaidChannelReceiptEmbed({
      text: message.content,
      resultGroups,
      accounts: receipt.accounts,
      afterWrite: receipt.afterWrite,
      guildName: message.guild?.name,
      lang: authorLang,
    });
    const dmSucceeded = await sendReceiptDm(message, receiptEmbed);
    const ops = [];
    const errorHint = buildRaidChannelErrorHint({
      resultGroups,
      accounts: receipt.accounts,
      authorLang,
      UI,
    });
    if (errorHint) ops.push(postPersistentHint(message, errorHint));

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
        resultGroups,
        accounts: receipt.accounts,
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
  MESSAGE_DEDUP_MAX_PERSISTED_IDS,
  createRaidChannelMessageHandler,
};
