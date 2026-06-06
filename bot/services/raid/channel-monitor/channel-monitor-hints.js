"use strict";

const { t: translate } = require("../../i18n");

const EMPTY_CONTENT_WARNING_COOLDOWN_MS = 5 * 60 * 1000;
const HINT_TTL_MS = 5 * 60 * 1000;
const MONITOR_COOLDOWN_MS = 2000;
const MONITOR_SPAM_WINDOW_MS = 10000;
const MONITOR_SPAM_THRESHOLD = 3;
const MONITOR_SPAM_WARN_CD_MS = 60000;

function createInitialCooldownEntry() {
  return {
    lastProcessedAt: 0,
    lastContent: "",
    lastExceptionAt: 0,
    spamHits: 0,
    spamWindowStart: 0,
    warnedAt: 0,
  };
}

function createRaidChannelHintService({
  UI,
  UserModel,
  normalizeName,
  getUserLanguage,
  t = translate,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const emptyContentWarningAt = new Map();
  const pendingChannelHints = new Map();
  const userMonitorCooldowns = new Map();

  function hintKey(guildId, channelId, userId) {
    return `${guildId}:${channelId}:${userId}`;
  }

  async function postTransientReply(message, content) {
    try {
      const reply = await message.reply({
        content,
        allowedMentions: { repliedUser: false },
      });
      setTimeoutFn(() => {
        reply.delete().catch(() => {});
      }, 10_000);
    } catch (err) {
      console.warn("[raid-channel] reply failed:", err?.message || err);
    }
  }

  async function postEmptyContentWarning(message) {
    const key = `${message.guildId}:${message.channelId}`;
    const currentTime = now();
    const last = emptyContentWarningAt.get(key) || 0;
    if (currentTime - last < EMPTY_CONTENT_WARNING_COOLDOWN_MS) return;
    emptyContentWarningAt.set(key, currentTime);

    const lang = await getUserLanguage(message.author.id, {
      UserModel,
    });
    await postTransientReply(
      message,
      t("text-parser.emptyContent", lang, { icon: UI.icons.warn })
    );
  }

  async function clearPendingHint(channel, key) {
    const entry = pendingChannelHints.get(key);
    if (!entry) return;
    pendingChannelHints.delete(key);
    if (entry.timerId) clearTimeoutFn(entry.timerId);

    const ids = [entry.hintId];
    if (entry.originalId) ids.push(entry.originalId);
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          const msg = await channel.messages.fetch(id);
          await msg.delete();
        } catch {
          // Already deleted or not fetchable.
        }
      })
    );
  }

  async function postPersistentHint(message, content) {
    const key = hintKey(message.guildId, message.channelId, message.author.id);
    await clearPendingHint(message.channel, key);
    try {
      const hint = await message.reply({ content });
      const timerId = setTimeoutFn(() => {
        clearPendingHint(message.channel, key).catch(() => {});
      }, HINT_TTL_MS);
      pendingChannelHints.set(key, {
        hintId: hint.id,
        originalId: message.id,
        timerId,
      });
    } catch (err) {
      console.warn("[raid-channel] persistent hint failed:", err?.message || err);
    }
  }

  function checkUserMonitorCooldown(message) {
    const key = hintKey(message.guildId, message.channelId, message.author.id);
    const currentTime = now();
    const contentKey = normalizeName(message.content);
    const entry = userMonitorCooldowns.get(key) || createInitialCooldownEntry();
    const withinCooldown = currentTime - entry.lastProcessedAt < MONITOR_COOLDOWN_MS;
    if (!withinCooldown) {
      return { accepted: true, warn: false, viaException: false };
    }

    const sameContent = contentKey && contentKey === entry.lastContent;
    const hasPendingHint = pendingChannelHints.has(key);
    const recentException =
      currentTime - (entry.lastExceptionAt || 0) < MONITOR_COOLDOWN_MS;
    if (hasPendingHint && !sameContent && !recentException) {
      return { accepted: true, warn: false, viaException: true };
    }

    if (currentTime - entry.spamWindowStart > MONITOR_SPAM_WINDOW_MS) {
      entry.spamHits = 1;
      entry.spamWindowStart = currentTime;
    } else {
      entry.spamHits += 1;
    }
    const shouldWarn =
      entry.spamHits >= MONITOR_SPAM_THRESHOLD &&
      currentTime - entry.warnedAt > MONITOR_SPAM_WARN_CD_MS;
    if (shouldWarn) entry.warnedAt = currentTime;
    userMonitorCooldowns.set(key, entry);
    return { accepted: false, warn: shouldWarn, viaException: false };
  }

  function commitUserMonitorActivity(message, viaException = false) {
    const key = hintKey(message.guildId, message.channelId, message.author.id);
    const currentTime = now();
    const contentKey = normalizeName(message.content);
    const entry = userMonitorCooldowns.get(key) || createInitialCooldownEntry();
    entry.lastProcessedAt = currentTime;
    entry.lastContent = contentKey;
    entry.lastExceptionAt = viaException ? currentTime : 0;
    entry.spamHits = 0;
    entry.spamWindowStart = 0;
    userMonitorCooldowns.set(key, entry);
  }

  async function postSpamWarning(message) {
    try {
      const lang = await getUserLanguage(message.author.id, {
        UserModel,
      });
      const reply = await message.reply({
        content: t("text-parser.spamWarn", lang),
      });
      setTimeoutFn(() => {
        reply.delete().catch(() => {});
      }, 15_000);
    } catch (err) {
      console.warn("[raid-channel] spam warning post failed:", err?.message || err);
    }
  }

  return {
    hintKey,
    postEmptyContentWarning,
    clearPendingHint,
    postPersistentHint,
    checkUserMonitorCooldown,
    commitUserMonitorActivity,
    postSpamWarning,
  };
}

module.exports = {
  createRaidChannelHintService,
};
