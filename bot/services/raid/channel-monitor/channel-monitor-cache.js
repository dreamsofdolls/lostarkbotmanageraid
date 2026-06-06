"use strict";

function createMonitorChannelCache({ GuildConfig }) {
  const monitorChannelCache = new Map();
  let monitorCacheHealthy = false;
  let monitorCacheLoadError = null;

  async function loadMonitorChannelCache() {
    try {
      const configs = await GuildConfig.find({}).lean();
      monitorChannelCache.clear();
      for (const config of configs) {
        monitorChannelCache.set(config.guildId, config.raidChannelId || null);
      }
      monitorCacheHealthy = true;
      monitorCacheLoadError = null;
      console.log(`[raid-channel] loaded ${configs.length} guild config(s) into cache.`);
    } catch (err) {
      monitorCacheHealthy = false;
      monitorCacheLoadError = err?.message || String(err);
      console.error("[raid-channel] cache load FAILED - monitor inactive until reload:", monitorCacheLoadError);
    }
  }

  function getMonitorCacheHealth() {
    return { healthy: monitorCacheHealthy, error: monitorCacheLoadError };
  }

  function getCachedMonitorChannelId(guildId) {
    return monitorChannelCache.get(guildId) ?? null;
  }

  function setCachedMonitorChannelId(guildId, channelId) {
    monitorChannelCache.set(guildId, channelId);
  }

  return {
    loadMonitorChannelCache,
    getMonitorCacheHealth,
    getCachedMonitorChannelId,
    setCachedMonitorChannelId,
  };
}

module.exports = {
  createMonitorChannelCache,
};
