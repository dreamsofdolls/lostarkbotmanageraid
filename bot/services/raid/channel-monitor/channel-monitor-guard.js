"use strict";

function createRaidChannelGuard() {
  const channelTails = new Map();
  const welcomeMessageIds = new Map();

  async function runExclusive(channelId, task) {
    const key = String(channelId || "");
    if (!key) return task();

    const previous = (channelTails.get(key) || Promise.resolve()).catch(() => {});
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    channelTails.set(key, tail);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (channelTails.get(key) === tail) channelTails.delete(key);
    }
  }

  function rememberWelcome(channelId, messageId) {
    if (!channelId || !messageId) return;
    welcomeMessageIds.set(String(channelId), String(messageId));
  }

  function forgetWelcome(channelId, messageId) {
    if (!channelId) return;
    const key = String(channelId);
    if (messageId && welcomeMessageIds.get(key) !== String(messageId)) return;
    welcomeMessageIds.delete(key);
  }

  function getProtectedMessageIds(channelId) {
    const messageId = welcomeMessageIds.get(String(channelId || ""));
    return messageId ? [messageId] : [];
  }

  return {
    forgetWelcome,
    getProtectedMessageIds,
    rememberWelcome,
    runExclusive,
  };
}

const raidChannelGuard = createRaidChannelGuard();

module.exports = {
  createRaidChannelGuard,
  raidChannelGuard,
};
