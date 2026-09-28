/**
 * services/raid/schedule/board-io.js
 * Discord I/O shared by the /raid-schedule handlers and the auto-lock and
 * purge workers: edit or delete a board's message, and post a line in its
 * channel. Every helper is best-effort: a missing channel, message or
 * permission resolves to false and is logged as `[raid-schedule] <logLabel>:`
 * (a null logLabel stays silent).
 */

"use strict";

function logFailure(logger, logLabel, error) {
  if (logLabel) logger.warn?.(`[raid-schedule] ${logLabel}:`, error?.message || error);
}

async function fetchBoardMessage(client, channelId, messageId) {
  const channel = await client.channels.fetch(channelId);
  return (await channel?.messages?.fetch(messageId)) || null;
}

/**
 * Edit a board message in place.
 * @param {object} client - discord.js client
 * @param {{channelId: string, messageId: string}} board - event (or ids) naming the message
 * @param {() => Promise<object>|object} buildPayload - called only once the message is found
 * @param {{logLabel?: string|null, logger?: object}} [options]
 * @returns {Promise<boolean>} true when the message was edited
 */
async function editBoardMessage(client, { channelId, messageId }, buildPayload, {
  logLabel = "board edit failed",
  logger = console,
} = {}) {
  if (!channelId || !messageId || !client?.channels) return false;
  try {
    const message = await fetchBoardMessage(client, channelId, messageId);
    if (!message) return false;
    await message.edit(await buildPayload());
    return true;
  } catch (error) {
    logFailure(logger, logLabel, error);
    return false;
  }
}

/**
 * Delete a board message.
 * @param {object} client - discord.js client
 * @param {{channelId: string, messageId: string}} board - event (or ids) naming the message
 * @param {{logLabel?: string|null, logger?: object}} [options]
 * @returns {Promise<boolean>} true when the message was deleted
 */
async function deleteBoardMessage(client, { channelId, messageId }, {
  logLabel = "board delete failed",
  logger = console,
} = {}) {
  if (!channelId || !messageId || !client?.channels) return false;
  try {
    const message = await fetchBoardMessage(client, channelId, messageId);
    if (!message) return false;
    await message.delete();
    return true;
  } catch (error) {
    logFailure(logger, logLabel, error);
    return false;
  }
}

/**
 * Post a message in a board's channel, such as a signup ping.
 * @param {object} client - discord.js client
 * @param {string} channelId - the board's channel
 * @param {object} payload - message payload
 * @param {{logLabel?: string|null, logger?: object}} [options]
 * @returns {Promise<void>}
 */
async function sendToBoardChannel(client, channelId, payload, {
  logLabel = "channel send failed",
  logger = console,
} = {}) {
  try {
    const channel = await client.channels.fetch(channelId);
    await channel?.send?.(payload);
  } catch (error) {
    logFailure(logger, logLabel, error);
  }
}

module.exports = {
  editBoardMessage,
  deleteBoardMessage,
  sendToBoardChannel,
};
