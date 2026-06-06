"use strict";

async function postChannelAnnouncement(channel, content, ttlMs, logTag = "announcement", components) {
  let sent = null;
  try {
    const payload = { content };
    if (Array.isArray(components) && components.length > 0) {
      payload.components = components;
    }
    sent = await channel.send(payload);
  } catch (err) {
    console.warn(`[${logTag}] send failed:`, err?.message || err);
    return null;
  }

  if (ttlMs > 0) {
    setTimeout(() => {
      sent.delete().catch(() => {});
    }, ttlMs);
  }
  return sent;
}

module.exports = {
  postChannelAnnouncement,
};
