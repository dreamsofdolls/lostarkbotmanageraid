"use strict";

function createAddRosterNoticeHelpers({
  EmbedBuilder,
  MessageFlags,
  buildNoticeEmbed,
}) {
  function buildNotice({ type, title, description }) {
    return buildNoticeEmbed(EmbedBuilder, { type, title, description });
  }

  async function replyNotice(interaction, notice) {
    await interaction.reply({
      embeds: [buildNotice(notice)],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function editNotice(interaction, notice, extras = {}) {
    await interaction.editReply({
      content: null,
      components: [],
      embeds: [buildNotice(notice)],
      ...extras,
    });
  }

  return {
    buildNotice,
    replyNotice,
    editNotice,
  };
}

module.exports = { createAddRosterNoticeHelpers };
