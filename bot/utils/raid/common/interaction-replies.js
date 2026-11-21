/**
 * utils/raid/common/interaction-replies.js
 * Ephemeral-by-default Discord interaction reply, defer, followUp, and edit
 * wrappers built around buildNoticeEmbed.
 */

"use strict";

const { buildNoticeEmbed } = require("./notices");

// Discord MessageFlags.Ephemeral as a literal constant. Imported once
// here so the notice-reply wrappers below don't need every caller to
// thread MessageFlags through. discord.js exports it as a frozen enum
// (numeric value 64) - safe to bake in.
const MESSAGE_FLAG_EPHEMERAL = 1 << 6; // 64

/**
 * Reply with a notice embed, ephemeral by default.
 * Caller passes EmbedBuilder so this stays decoupled from discord.js imports.
 * Pass `ephemeral: false` to broadcast to the channel, and include extra reply
 * payload fields such as `components` when needed.
 */
function replyNotice(interaction, EmbedBuilder, options, { ephemeral = true, ...extras } = {}) {
  const payload = {
    embeds: [buildNoticeEmbed(EmbedBuilder, options)],
    ...extras,
  };
  if (ephemeral) payload.flags = MESSAGE_FLAG_EPHEMERAL;
  return interaction.reply(payload);
}

/**
 * Reply with already-built embed(s), ephemeral by default. Use this for
 * richer custom embeds that do not fit the notice shape but still repeat
 * the same `embeds + flags` Discord payload boilerplate.
 */
function replyEmbed(interaction, embedOrEmbeds, { ephemeral = true, ...extras } = {}) {
  const payload = {
    embeds: Array.isArray(embedOrEmbeds) ? embedOrEmbeds : [embedOrEmbeds],
    ...extras,
  };
  if (ephemeral) payload.flags = MESSAGE_FLAG_EPHEMERAL;
  return interaction.reply(payload);
}

/**
 * Defer an interaction reply as ephemeral. Keeps the raw Discord flag in
 * one place for longer-running command branches.
 */
function deferEphemeralReply(interaction) {
  return interaction.deferReply({ flags: MESSAGE_FLAG_EPHEMERAL });
}

/**
 * Await a pending defer and say whether it took. A failed defer (an expired
 * or already acknowledged interaction) is logged under `label`, and the
 * caller returns without replying.
 * @param {string} label - log prefix naming the step, e.g. "[raid-status] local-refresh"
 * @param {Promise<unknown>} deferPromise - the pending deferUpdate or deferReply
 * @returns {Promise<boolean>} true when the defer succeeded
 */
async function deferOrWarn(label, deferPromise) {
  try {
    await deferPromise;
    return true;
  } catch (err) {
    console.warn(`${label} defer failed:`, err?.message || err);
    return false;
  }
}

/**
 * Follow up with a notice embed, ephemeral by default. Mirrors
 * replyNotice for component flows that already used deferUpdate and need
 * a lightweight toast without re-rendering the source message.
 */
function followUpNotice(interaction, EmbedBuilder, options, { ephemeral = true } = {}) {
  const payload = {
    embeds: [buildNoticeEmbed(EmbedBuilder, options)],
  };
  if (ephemeral) payload.flags = MESSAGE_FLAG_EPHEMERAL;
  return interaction.followUp(payload);
}

/**
 * editReply with a notice embed. Used for follow-up edits on a deferred
 * reply or after a slow operation. ephemeral flag is determined by the
 * original deferReply, so this wrapper just edits in place.
 */
function editNotice(interaction, EmbedBuilder, options, extras = {}) {
  return interaction.editReply({
    ...extras,
    embeds: [buildNoticeEmbed(EmbedBuilder, options)],
  });
}

/**
 * editReply with already-built embed(s). Pairs with replyEmbed for
 * deferred branches that build richer custom embeds.
 */
function editEmbed(interaction, embedOrEmbeds, extras = {}) {
  return interaction.editReply({
    ...extras,
    embeds: Array.isArray(embedOrEmbeds) ? embedOrEmbeds : [embedOrEmbeds],
  });
}

module.exports = {
  replyNotice,
  replyEmbed,
  deferEphemeralReply,
  deferOrWarn,
  followUpNotice,
  editNotice,
  editEmbed,
};
