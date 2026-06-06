"use strict";

function createRaidChannelWelcomeService({
  GuildConfig,
  getGuildLanguage,
  buildRaidChannelWelcomeEmbed,
  welcomeTitleLanguages = ["vi", "jp", "en"],
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

  async function collectStaleWelcomeIds(channel, botUserId, guildId) {
    const staleIds = new Set();
    if (guildId) {
      try {
        const cfg = await GuildConfig.findOne({ guildId }).lean();
        if (cfg?.welcomeMessageId) staleIds.add(cfg.welcomeMessageId);
      } catch (err) {
        console.warn("[raid-channel] GuildConfig read for welcomeMessageId failed:", err?.message || err);
      }
    }

    try {
      const { items: pins = [] } = await channel.messages.fetchPins();
      for (const pin of pins) {
        const msg = pin?.message;
        if (isWelcomePinMessage(msg, botUserId)) staleIds.add(msg.id);
      }
    } catch (err) {
      console.warn("[raid-channel] fetchPins for stale-welcome scan failed:", err?.message || err);
    }
    return staleIds;
  }

  async function persistFreshWelcome(sent, guildId, outcome) {
    if (!guildId) {
      outcome.persisted = true;
      return;
    }

    try {
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $set: { welcomeMessageId: sent.id } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      outcome.persisted = true;
    } catch (err) {
      console.warn("[raid-channel] persist welcomeMessageId failed:", err?.message || err);
      try {
        await sent.unpin();
      } catch (unpinErr) {
        console.warn("[raid-channel] rollback-unpin after persist fail also failed:", unpinErr?.message || unpinErr);
      }
      outcome.pinned = false;
    }
  }

  async function deleteStaleWelcomes(channel, staleIds, outcome) {
    for (const id of staleIds) {
      try {
        const oldMsg = await channel.messages.fetch(id);
        await oldMsg.delete();
        outcome.removedOldCount += 1;
      } catch {
        // Stale welcome is already gone or not fetchable.
      }
    }
  }

  async function postRaidChannelWelcome(channel, botUserId, guildId) {
    const outcome = { posted: false, pinned: false, persisted: false, removedOldCount: 0 };
    const staleIds = await collectStaleWelcomeIds(channel, botUserId, guildId);
    const guildLang = await getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
    const embed = buildRaidChannelWelcomeEmbed(guildLang);

    try {
      const sent = await channel.send({ embeds: [embed] });
      outcome.posted = true;
      try {
        await sent.pin();
        outcome.pinned = true;
        await persistFreshWelcome(sent, guildId, outcome);
      } catch (err) {
        console.warn("[raid-channel] pin fresh welcome failed:", err?.message || err);
      }
    } catch (err) {
      console.warn("[raid-channel] post welcome failed:", err?.message || err);
    }

    if (outcome.posted && outcome.pinned && outcome.persisted && staleIds.size > 0) {
      await deleteStaleWelcomes(channel, staleIds, outcome);
    }
    return outcome;
  }

  return {
    postRaidChannelWelcome,
  };
}

module.exports = {
  createRaidChannelWelcomeService,
};
