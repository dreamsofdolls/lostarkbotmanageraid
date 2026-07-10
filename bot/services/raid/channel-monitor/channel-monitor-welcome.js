"use strict";

const { raidChannelGuard } = require("./channel-monitor-guard");

function createRaidChannelWelcomeService({
  GuildConfig,
  getGuildLanguage,
  buildRaidChannelWelcomeEmbed,
  welcomeTitleLanguages = ["vi", "jp", "en"],
  channelGuard = raidChannelGuard,
}) {
  function buildWelcomeTitleSignatures() {
    const signatures = new Set();
    for (const lang of welcomeTitleLanguages) {
      try {
        const title = buildRaidChannelWelcomeEmbed(lang)?.toJSON?.()?.title || "";
        if (title) signatures.add(title);
      } catch {
        // Ignore bad injected builders; posting still uses the real guild lang.
      }
    }
    return signatures;
  }

  const welcomeTitleSignatures = buildWelcomeTitleSignatures();

  function isWelcomePinMessage(msg, botUserId) {
    if (!msg || msg.author?.id !== botUserId) return false;
    const title = msg.embeds?.[0]?.title || "";
    for (const signature of welcomeTitleSignatures) {
      if (signature && title.includes(signature)) return true;
    }
    return false;
  }

  async function collectStaleWelcomeRefs(
    channel,
    botUserId,
    guildId,
    { previousChannelId } = {}
  ) {
    const staleRefs = new Map();
    const add = (channelId, messageId, message = null) => {
      if (!channelId || !messageId) return;
      staleRefs.set(`${channelId}:${messageId}`, { channelId, messageId, message });
    };

    if (guildId) {
      try {
        const cfg = await GuildConfig.findOne({ guildId }).lean();
        add(
          cfg?.welcomeChannelId || previousChannelId || cfg?.raidChannelId || channel.id,
          cfg?.welcomeMessageId
        );
      } catch (err) {
        console.warn("[raid-channel] GuildConfig read for welcomeMessageId failed:", err?.message || err);
      }
    }

    try {
      const { items: pins = [] } = await channel.messages.fetchPins();
      for (const pin of pins) {
        const msg = pin?.message;
        if (isWelcomePinMessage(msg, botUserId)) add(channel.id, msg.id, msg);
      }
    } catch (err) {
      console.warn("[raid-channel] fetchPins for stale-welcome scan failed:", err?.message || err);
    }
    return staleRefs;
  }

  async function persistFreshWelcome(sent, channelId, guildId) {
    if (!guildId) {
      return;
    }

    await GuildConfig.findOneAndUpdate(
      { guildId },
      {
        $set: {
          welcomeMessageId: sent.id,
          welcomeChannelId: channelId,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  async function rollbackFresh(sent) {
    try {
      await sent.unpin?.();
    } catch (err) {
      console.warn("[raid-channel] rollback-unpin fresh welcome failed:", err?.message || err);
    }
    try {
      await sent.delete?.();
    } catch (err) {
      console.warn("[raid-channel] rollback-delete fresh welcome failed:", err?.message || err);
    }
  }

  async function resolveStaleMessage(ref, channel, client) {
    if (ref.message) return ref.message;
    try {
      let sourceChannel = ref.channelId === channel.id ? channel : null;
      if (!sourceChannel) {
        sourceChannel = client?.channels?.cache?.get?.(ref.channelId) || null;
      }
      if (!sourceChannel) {
        sourceChannel = await client?.channels?.fetch?.(ref.channelId);
      }
      if (!sourceChannel) {
        sourceChannel = channel.guild?.channels?.cache?.get?.(ref.channelId) || null;
      }
      if (!sourceChannel) {
        sourceChannel = await channel.guild?.channels?.fetch?.(ref.channelId);
      }
      return await sourceChannel?.messages?.fetch?.(ref.messageId);
    } catch {
      return null;
    }
  }

  async function deleteStaleWelcomes(channel, staleRefs, client, outcome) {
    for (const ref of staleRefs.values()) {
      const oldMsg = await resolveStaleMessage(ref, channel, client);
      if (!oldMsg) continue;
      try {
        await oldMsg.delete();
        outcome.removedOldCount += 1;
      } catch {
        // Stale welcome is already gone or not fetchable.
      }
    }
  }

  async function postRaidChannelWelcomeLocked(
    channel,
    botUserId,
    guildId,
    { client, previousChannelId } = {}
  ) {
    const outcome = { posted: false, pinned: false, persisted: false, removedOldCount: 0 };
    const staleRefs = await collectStaleWelcomeRefs(
      channel,
      botUserId,
      guildId,
      { previousChannelId }
    );
    const guildLang = await getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
    const embed = buildRaidChannelWelcomeEmbed(guildLang);

    let sent;
    try {
      sent = await channel.send({ embeds: [embed] });
      outcome.posted = true;
      await sent.pin();
      outcome.pinned = true;
    } catch (err) {
      console.warn("[raid-channel] post or pin fresh welcome failed:", err?.message || err);
      if (sent) await rollbackFresh(sent);
      outcome.pinned = false;
      return outcome;
    }

    try {
      await persistFreshWelcome(sent, channel.id, guildId);
      outcome.persisted = true;
    } catch (err) {
      console.warn("[raid-channel] persist welcomeMessageId failed:", err?.message || err);
      await rollbackFresh(sent);
      outcome.pinned = false;
      return outcome;
    }

    channelGuard.rememberWelcome(channel.id, sent.id);
    for (const ref of staleRefs.values()) {
      channelGuard.forgetWelcome(ref.channelId, ref.messageId);
    }
    if (staleRefs.size > 0) {
      await deleteStaleWelcomes(channel, staleRefs, client, outcome);
    }
    return outcome;
  }

  async function postRaidChannelWelcome(channel, botUserId, guildId, options = {}) {
    return channelGuard.runExclusive(
      channel?.id,
      () => postRaidChannelWelcomeLocked(channel, botUserId, guildId, options)
    );
  }

  return {
    postRaidChannelWelcome,
  };
}

module.exports = {
  createRaidChannelWelcomeService,
};
